/**
 * Simulated Demo — Voice Orchestrator
 *
 * Demonstrates the three critical scenarios without requiring
 * a Gemini API key or audio hardware:
 *
 *   Demo 1: Normal flow (speak → tool → response)
 *   Demo 2: Interrupt mid-response (barge-in)
 *   Demo 3: Interrupt mid-tool (hardest — tool cancellation)
 *
 * Run: npx tsx src/demo-simulated.ts
 */

import { VoiceStateMachine, VoiceState } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";
import { InterruptHandler } from "./interruptHandler.js";
import { ToolOrchestrator, ToolDefinition } from "./toolOrchestrator.js";

// ── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ICONS: Record<VoiceState, string> = {
  [VoiceState.LISTENING]: "🎙️ ",
  [VoiceState.THINKING]: "🧠",
  [VoiceState.SPEAKING]: "🔊",
  [VoiceState.TOOL_EXEC]: "🔧",
};

function logState(from: VoiceState, to: VoiceState, event: string): void {
  console.log(`   ${ICONS[from]} ${from} → ${ICONS[to]} ${to}  [${event}]`);
}

// ── Setup ───────────────────────────────────────────────────────

function createOrchestrator() {
  const sm = new VoiceStateMachine();
  const tm = new TranscriptManager();

  const ih = new InterruptHandler(
    sm,
    tm,
    () => console.log("   ⏹️  Playback stopped"),
    () => console.log("   ⛔ Generation cancelled (sendInterrupt)")
  );

  const to = new ToolOrchestrator(ih);

  sm.onChange((from, to, event) => logState(from, to, event.type));

  // Register a slow tool to demonstrate cancellation
  const slowTool: ToolDefinition = {
    name: "read_file",
    description: "Read a file (simulated with delay)",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (args, signal) => {
      console.log(`   📂 Reading ${args.path}...`);
      // Simulate slow I/O — interrupt can cancel at each iteration
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        signal.throwIfAborted();
      }
      return { content: `Contents of ${args.path}` };
    },
  };

  to.registerTool(slowTool);

  return { sm, tm, ih, to };
}

// ── Demo 1: Normal Flow ─────────────────────────────────────────

async function demo1() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Demo 1: Normal Flow                            ║");
  console.log("║  User speaks → tool runs → response streams     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const { sm, tm } = createOrchestrator();

  // User starts speaking
  console.log('👤 User: "Read the README file"');
  tm.updatePartial("Read the README");
  await sleep(300);
  tm.updatePartial("Read the README file");
  const seg = tm.commitUser("Read the README file");
  console.log(`   📝 Committed: "${seg.text}"`);

  // User finishes → THINKING
  sm.transition({ type: "SPEECH_END", transcript: seg.text });
  await sleep(500);

  // Tool call
  console.log("\n   🔧 Model requests: read_file(README.md)");
  tm.flushBeforeTool();
  sm.transition({
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: { path: "README.md" },
  });
  await sleep(800);
  sm.transition({
    type: "TOOL_CALL_END",
    result: { content: "# Voice Orchestrator..." },
  });

  // Model streams response
  sm.transition({ type: "MODEL_STREAM_START" });
  const response = "The README describes the Voice Orchestrator prototype.";
  for (const word of response.split(" ")) {
    process.stdout.write(` ${word}`);
    await sleep(100);
  }
  console.log();
  tm.commitModel(response);

  // Turn complete
  sm.transition({ type: "MODEL_STREAM_END" });

  console.log("\n   ✅ Normal flow complete");
  console.log(`   📋 Transcript:\n${tm.toPlainText()}`);
}

// ── Demo 2: Interrupt Mid-Response ──────────────────────────────

async function demo2() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Demo 2: Barge-In (Interrupt Mid-Response)      ║");
  console.log("║  Model speaking → user interrupts → clean reset ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const { sm, tm, ih } = createOrchestrator();

  // User asks something
  console.log('👤 User: "Explain the architecture"');
  tm.commitUser("Explain the architecture");
  sm.transition({
    type: "SPEECH_END",
    transcript: "Explain the architecture",
  });
  await sleep(300);

  // Model starts responding
  sm.transition({ type: "MODEL_STREAM_START" });
  const fullResponse =
    "The architecture uses a streaming state machine with four states. First LISTENING where...";
  const words = fullResponse.split(" ");

  // Buffer to simulate modelResponseBuffer in index.ts
  let partialBuffer = "";

  for (let i = 0; i < words.length; i++) {
    process.stdout.write(` ${words[i]}`);
    partialBuffer += (i > 0 ? " " : "") + words[i];
    await sleep(120);

    // User interrupts halfway through
    if (i === 6) {
      console.log("\n\n   🗣️ USER INTERRUPTS!");
      console.log('   👤 "Wait — what about tool support?"');

      // Simulate what the real index.ts does on "interrupted" event:
      // commit whatever the model had streamed so far as interrupted.
      if (partialBuffer) {
        tm.commitModel(partialBuffer, true);
        partialBuffer = "";
      }

      // This is the critical moment:
      // interrupt() → stopPlayback + sendInterrupt + cancelOps + rollback + state
      ih.interrupt();

      // New user input
      await sleep(200);
      tm.commitUser("What about tool support?");
      sm.transition({
        type: "SPEECH_END",
        transcript: "What about tool support?",
      });
      break;
    }
  }

  await sleep(300);
  console.log("\n   ✅ Barge-in handled cleanly");
  console.log(`   📋 Transcript:\n${tm.toPlainText()}`);
  console.log("   ↑ Note: model response marked with ✂ (interrupted)");
}

// ── Demo 3: Interrupt Mid-Tool (THE HARD ONE) ───────────────────

async function demo3() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Demo 3: Interrupt Mid-Tool Execution           ║");
  console.log("║  Tool running → user changes intent → cancelled ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const { sm, tm, ih, to } = createOrchestrator();

  // User asks to read a file
  console.log('👤 User: "Open the trainer docs"');
  tm.commitUser("Open the trainer docs");
  sm.transition({
    type: "SPEECH_END",
    transcript: "Open the trainer docs",
  });
  await sleep(300);

  // Model triggers tool call
  console.log("\n   🔧 Model requests: read_file(docs/trainer.md)");
  tm.flushBeforeTool();
  sm.transition({
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: { path: "docs/trainer.md" },
  });

  // Start tool execution (non-blocking)
  const toolPromise = to.execute("read_file", { path: "docs/trainer.md" });

  // Wait 600ms then interrupt (tool takes 2000ms total)
  await sleep(600);

  console.log("\n   🗣️ USER INTERRUPTS DURING TOOL EXECUTION!");
  console.log('   👤 "Actually, search for kubeflow instead"');

  // The critical moment: interrupt cancels the in-flight tool via AbortController
  ih.interrupt();

  // Wait for tool to acknowledge cancellation
  const result = await toolPromise;
  console.log(
    `\n   Tool result: cancelled=${result.cancelled}, duration=${result.durationMs}ms`
  );

  // New user intent
  await sleep(200);
  tm.commitUser("Search for kubeflow instead");
  sm.transition({
    type: "SPEECH_END",
    transcript: "Search for kubeflow instead",
  });

  await sleep(300);
  console.log(
    "\n   ✅ Mid-tool interrupt handled — old tool cancelled, new intent captured"
  );
  console.log(`   📋 Transcript:\n${tm.toPlainText()}`);
}

// ── Run all demos ───────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Streaming Voice-Agent Orchestrator — Demo Suite  ");
  console.log("  Proving: interruptible, tool-aware, streaming    ");
  console.log("═══════════════════════════════════════════════════");

  await demo1();
  await sleep(1000);

  await demo2();
  await sleep(1000);

  await demo3();

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  All demos complete.                              ");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
