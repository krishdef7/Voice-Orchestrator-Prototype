/**
 * Voice Orchestrator — Main Entry Point
 *
 * Wires together:
 *   GeminiLiveClient  →  Live API WebSocket
 *   AudioIO           →  mic input / speaker output
 *   VoiceStateMachine →  state management
 *   TranscriptManager →  partial/committed transcripts
 *   InterruptHandler  →  barge-in coordination
 *   ToolOrchestrator  →  cancellable tool execution
 *
 * Usage:
 *   GEMINI_API_KEY=<key> npx tsx src/index.ts
 */

import { GeminiLiveClient } from "./liveClient.js";
import { AudioIO } from "./audioIO.js";
import { VoiceStateMachine, VoiceState } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";
import { InterruptHandler } from "./interruptHandler.js";
import { ToolOrchestrator, ToolDefinition } from "./toolOrchestrator.js";
import { readFile } from "fs/promises";
import { execFile } from "child_process";

// ── Config ──────────────────────────────────────────────────────

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Error: Set GEMINI_API_KEY environment variable");
  console.error("Get a key at: https://aistudio.google.com/apikey");
  process.exit(1);
}

// Push-to-talk mode disables server-side VAD and uses
// activityStart/activityEnd signals instead.
const USE_PTT = process.argv.includes("--ptt");

// ── Initialise components ───────────────────────────────────────

const stateMachine = new VoiceStateMachine();
const transcript = new TranscriptManager();
const audio = new AudioIO();

// Declared before liveClient so the interrupt handler closure can
// reference it. Assigned immediately after liveClient is constructed.
let liveClient: GeminiLiveClient;

const interruptHandler = new InterruptHandler(
  stateMachine,
  transcript,
  () => audio.stopPlayback(),
  () => {
    // Send interrupt signal to the Live API.
    // Per the docs: "A [clientContent] message will interrupt any
    // current model generation."
    liveClient.sendInterrupt();
  }
);

const toolOrchestrator = new ToolOrchestrator(interruptHandler);

// ── Register example tools (mirrors Gemini CLI ToolRegistry) ────

const exampleTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
      },
      required: ["path"],
    },
    execute: async (args, signal) => {
      signal.throwIfAborted();
      const content = await readFile(args.path as string, "utf-8");
      signal.throwIfAborted();
      return { content: content.slice(0, 2000) }; // truncate for voice
    },
  },
  {
    name: "search_code",
    description: "Search for a pattern in the codebase",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    execute: async (args, signal) => {
      signal.throwIfAborted();
      try {
        // Async execFile — does NOT block the event loop.
        // execFileSync would freeze all WebSocket, audio, and barge-in
        // processing for up to 5 seconds while grep runs.
        const result = await new Promise<string>((resolve, _reject) => {
          const child = execFile(
            "grep",
            ["-rn", args.query as string, ".", "--include=*.ts", "-l"],
            { encoding: "utf-8", timeout: 5000 },
            (_err, stdout) => {
              // grep exits 1 when no matches found — that's normal, not an error.
              // Always resolve with whatever stdout we got.
              resolve(stdout || "");
            }
          );
          // Wire abort signal → kill child process immediately on barge-in.
          signal.addEventListener("abort", () => child.kill(), { once: true });
        });
        signal.throwIfAborted();
        const files = result.trim().split("\n").filter(Boolean).slice(0, 10);
        return { files };
      } catch {
        return { files: [] };
      }
    },
  },
];

for (const tool of exampleTools) {
  toolOrchestrator.registerTool(tool);
}

// ── State change logging ────────────────────────────────────────

const STATE_ICONS: Record<VoiceState, string> = {
  [VoiceState.LISTENING]: "🎙️",
  [VoiceState.THINKING]: "🧠",
  [VoiceState.SPEAKING]: "🔊",
  [VoiceState.TOOL_EXEC]: "🔧",
};

stateMachine.onChange((from, to, event) => {
  console.log(`\n${STATE_ICONS[to]}  ${from} → ${to}  (${event.type})`);
});

// ── Build Live API client ───────────────────────────────────────

liveClient = new GeminiLiveClient({
  apiKey: API_KEY,
  manualVAD: USE_PTT,
  autoReconnect: true,
  systemInstruction:
    "You are a voice-enabled coding assistant for Gemini CLI. " +
    "Keep responses concise and spoken-friendly. " +
    "When the user asks about files or code, use the available tools.",
  tools: toolOrchestrator.getToolDeclarations(),
});

// ── Wire: Live API events → state machine + transcript ──────────

let modelResponseBuffer = "";
// Track whether we've received text from modelTurn.parts (content events).
// In audio-only responses, text content never arrives — output transcription
// is the only source. In text+audio mode, both arrive and we must avoid
// double-counting.
let receivedTextContent = false;
// PTT state — module level so setupComplete can reset it on reconnect.
// If this were inside setupKeyboardInput(), the setupComplete handler
// couldn't see it, leaving stale PTT state after WebSocket reconnect.
let holdingPtt = false;

/**
 * Ensure the state machine has left LISTENING before processing model events.
 *
 * With server-side auto-VAD, there is no explicit "user stopped speaking"
 * signal from the server. The first sign the model is responding is when
 * content events or tool calls arrive. At that point we must:
 *   1. Commit any pending user transcript (partial → committed)
 *   2. Fire SPEECH_END to transition LISTENING → THINKING
 *
 * In PTT mode, SPEECH_END is fired when the user releases the space bar,
 * so this function is a no-op (state is already THINKING).
 *
 * This is safe to call multiple times — if we're already past LISTENING,
 * the SPEECH_END transition returns null (no-op).
 */
function ensureModelTurn(): void {
  if (stateMachine.current === VoiceState.LISTENING) {
    // Commit user's speech before the model turn begins.
    // Input transcription may or may not have arrived yet (ordering
    // is not guaranteed per the API spec), but commit whatever we have.
    const partialText = transcript.getPartial();
    if (partialText.trim()) {
      transcript.commitUser(partialText);
    }
    stateMachine.transition({
      type: "SPEECH_END",
      transcript: partialText || "",
    });
  }
}

liveClient.on("content", (event) => {
  switch (event.type) {
    case "text":
      ensureModelTurn();
      if (stateMachine.current === VoiceState.THINKING) {
        stateMachine.transition({ type: "MODEL_STREAM_START" });
      }
      // On first text content event in this turn, discard any output
      // transcription that leaked into the buffer. The API spec says
      // transcription ordering is not guaranteed — if output transcription
      // arrived before this text event, the buffer has transcription text
      // that would be double-counted alongside the authoritative text.
      // Text content is the canonical source; transcription is only a
      // fallback for audio-only mode where no text parts are sent.
      if (!receivedTextContent) {
        receivedTextContent = true;
        modelResponseBuffer = "";
      }
      modelResponseBuffer += event.text ?? "";
      process.stdout.write(event.text ?? "");
      break;

    case "audio":
      ensureModelTurn();
      if (stateMachine.current === VoiceState.THINKING) {
        stateMachine.transition({ type: "MODEL_STREAM_START" });
      }
      if (event.audioData) {
        audio.queuePlayback(Buffer.from(event.audioData, "base64"));
      }
      break;

    case "turn_complete":
      // Model finished its response (or server confirmed end after interrupt).
      if (modelResponseBuffer) {
        transcript.commitModel(modelResponseBuffer);
        modelResponseBuffer = "";
      }
      receivedTextContent = false;
      // If interrupted handler already moved us to LISTENING, this is a
      // safe no-op (LISTENING + MODEL_STREAM_END → null).
      stateMachine.transition({ type: "MODEL_STREAM_END" });
      break;

    case "interrupted":
      // Server acknowledged interrupt (either client-initiated or server VAD).
      // Commit whatever the model had streamed so far as interrupted.
      if (modelResponseBuffer) {
        transcript.commitModel(modelResponseBuffer, true);
        modelResponseBuffer = "";
      }
      receivedTextContent = false;
      // Stop playback immediately. Critical for server-initiated interrupts
      // where client-side energy detection may not have fired yet.
      audio.stopPlayback();
      // Transition state. The server sends interrupted → turn_complete,
      // but if we're in THINKING (no MODEL_STREAM_START yet), the
      // turn_complete → MODEL_STREAM_END transition would be invalid.
      // Explicitly go to LISTENING here to prevent getting stuck.
      if (stateMachine.current !== VoiceState.LISTENING) {
        stateMachine.transition({ type: "INTERRUPT" });
      }
      console.log("[Server] Acknowledged interrupt");
      break;
  }
});

// Transcription events — the server transcribes both input and output audio.
// This gives us real transcripts without client-side ASR.
liveClient.on("transcription", (event) => {
  if (event.direction === "input") {
    // Update the partial transcript with server-provided transcription.
    transcript.updatePartial(event.text);
    console.log(`[Transcription] User: ${event.text}`);
  } else {
    // In audio-only mode, the model sends audio but NOT text content events.
    // Output transcription is the only source of model text for the transcript.
    // Only use it if we haven't already received text from content events.
    // Use += because the API delivers transcription in incremental chunks —
    // each event contains new text since the last event, not the cumulative
    // transcript. Using = would discard all previous chunks.
    if (!receivedTextContent) {
      modelResponseBuffer += event.text;
    }
    console.log(`[Transcription] Model: ${event.text}`);
  }
});

liveClient.on("toolCall", async (call) => {
  console.log(`\n[ToolCall] ${call.name}(${JSON.stringify(call.args)})`);

  ensureModelTurn();
  transcript.flushBeforeTool();
  stateMachine.transition({
    type: "TOOL_CALL_START",
    toolName: call.name,
    args: call.args,
  });

  const result = await toolOrchestrator.execute(call.name, call.args, call.id);

  if (!result.cancelled) {
    console.log(
      `[ToolResult] ${call.name}: ${JSON.stringify(result.result).slice(0, 200)}`
    );

    // Only transition out of TOOL_EXEC when ALL parallel tools complete.
    // The Live API can send multiple FunctionCalls in one message — they
    // all run concurrently. If we transition on the first completion,
    // the state moves to SPEAKING while other tools are still running,
    // and their TOOL_CALL_END events would be invalid (silently dropped).
    if (toolOrchestrator.activeCallCount === 0) {
      stateMachine.transition({ type: "TOOL_CALL_END", result: result.result });
    }

    // Always send the result back regardless of whether other tools
    // are still running — the API expects individual responses.
    liveClient.sendToolResponse(call.id, call.name, result.result);
  } else {
    console.log(`[ToolCancelled] ${call.name} was interrupted`);
  }
});

// Handle server-initiated tool cancellation.
// The Live API sends this when the user interrupts during tool execution.
liveClient.on("toolCallCancellation", (event) => {
  console.log(
    `[ToolCallCancellation] Server cancelled: ${event.ids.join(", ")}`
  );
  // Cancel only the specific tools the server asked to cancel.
  // cancelAll() would be wrong here — the model may have requested
  // multiple parallel tools but only wants to cancel a subset.
  toolOrchestrator.cancelByIds(event.ids);
  // Defensively transition to LISTENING. The server usually also sends an
  // "interrupted" event, but message ordering is not guaranteed. If we're
  // still in TOOL_EXEC after cancellation, force the transition.
  if (stateMachine.current === VoiceState.TOOL_EXEC) {
    audio.stopPlayback();
    stateMachine.transition({ type: "INTERRUPT" });
  }
});

// GoAway — server will disconnect soon. In production, reconnect.
liveClient.on("goAway", (event) => {
  console.warn(
    `[GoAway] Server disconnecting in ${event.timeLeftMs}ms. ` +
      `Reconnect to continue session.`
  );
});

// Connection lost — clean up state for reconnect.
// After auto-reconnect, a fresh Live API session starts but our local
// state (FSM, buffer, tools) could be stale from the previous session.
liveClient.on("disconnected", (_code, _reason) => {
  toolOrchestrator.cancelAll();
  audio.stopPlayback();
  if (modelResponseBuffer) {
    transcript.commitModel(modelResponseBuffer, true);
    modelResponseBuffer = "";
  }
  receivedTextContent = false;
  stateMachine.reset();
});

liveClient.on("error", (err) => {
  console.error("[LiveAPI Error]", err.message);
  stateMachine.transition({ type: "ERROR", error: err });
});

// Reset all state on (re)connect. After auto-reconnect, the Live API session
// is fresh but local state (state machine, buffers, pending operations) may be
// stale from before disconnection. This handler fires on both initial connect
// and reconnect since setupComplete is emitted for every new session.
liveClient.on("setupComplete", () => {
  stateMachine.reset();
  toolOrchestrator.cancelAll();
  audio.stopPlayback();
  modelResponseBuffer = "";
  receivedTextContent = false;
  // Reset PTT state — after reconnect the server has no memory of
  // a pending activityStart, so holdingPtt=true would cause the next
  // space press to send activityEnd with no matching activityStart.
  holdingPtt = false;
});

// ── Wire: Audio input → Live API + interrupt detection ──────────

audio.on("audioData", (chunk) => {
  // Forward audio in ALL states, not just LISTENING.
  // The Live API's server-side VAD needs audio during SPEAKING/THINKING
  // to detect barge-in. Per the docs, realtimeInput "can be sent
  // continuously without interruption to model generation."
  liveClient.sendAudio(chunk);
});

audio.on("energy", (level) => {
  // Client-side interrupt detection supplements server-side VAD
  // for lower latency (stop playback before server ack arrives).
  // Disabled in PTT mode — user controls turns manually via space bar.
  if (!USE_PTT && interruptHandler.shouldInterrupt(level)) {
    console.log(`[Barge-in] Detected speech during ${stateMachine.current}`);
    interruptHandler.interrupt();
  }
});

// ── Keyboard Input ───────────────────────────────────────────────
// Handles Ctrl+C (all modes) and space bar (PTT mode only).
// In auto-VAD mode, activityStart/activityEnd must NOT be sent —
// per the API spec: "This can only be sent if automatic (i.e.
// server-side) activity detection is disabled."

function setupKeyboardInput(): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key: string) => {
    // Ctrl+C → exit (always active)
    if (key === "\u0003") {
      shutdown();
      return;
    }

    // Space → push-to-talk toggle (PTT mode only)
    if (USE_PTT && key === " ") {
      if (!holdingPtt) {
        holdingPtt = true;
        liveClient.sendActivityStart();
        console.log("[PTT] 🔴 Recording...");
      } else {
        holdingPtt = false;
        liveClient.sendActivityEnd();
        // Commit user speech and transition to THINKING.
        // Input transcription may still be arriving, but commit what we have.
        const partialText = transcript.getPartial();
        if (partialText.trim()) {
          transcript.commitUser(partialText);
        }
        stateMachine.transition({
          type: "SPEECH_END",
          transcript: partialText || "",
        });
        console.log("[PTT] ⬜ Sent end-of-speech");
      }
    }
  });
}

// ── Shutdown ────────────────────────────────────────────────────

function shutdown(): void {
  console.log("\n\n📋 Session transcript:");
  console.log(transcript.toPlainText());
  audio.destroy();
  liveClient.disconnect();
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Voice Orchestrator — Gemini Live API PoC       ║");
  console.log("║  Streaming · Interruptible · Tool-aware         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Mode: ${USE_PTT ? "Push-to-Talk (manual VAD)" : "Auto-VAD"}\n`);

  // 1. Init audio
  const hasAudio = await audio.init();
  if (!hasAudio) {
    console.log("⚠️  No audio hardware detected. Running in text-only mode.");
    console.log("   Use `npm run demo` for the simulated demo.\n");
  }

  // 2. Connect to Live API
  console.log("Connecting to Gemini Live API...");
  try {
    await liveClient.connect();
    console.log("✅ Connected!\n");
  } catch (err) {
    console.error("❌ Failed to connect:", (err as Error).message);
    console.log("\nMake sure GEMINI_API_KEY is set and valid.");
    console.log("Get a key at: https://aistudio.google.com/apikey\n");
    process.exit(1);
  }

  // 3. Start mic capture + input handler
  if (hasAudio) {
    audio.startCapture();
    if (USE_PTT) {
      console.log("🎙️  Push-to-talk: press SPACE to record, SPACE again to send\n");
    } else {
      console.log("🎙️  Listening... (speak to interact, Ctrl+C to quit)\n");
    }
  }

  setupKeyboardInput();
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
