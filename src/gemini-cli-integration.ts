/**
 * gemini-cli Integration Layer — Voice Mode Service
 *
 * Location in gemini-cli: packages/core/src/voice/
 *
 * This file maps the voice orchestrator prototype to gemini-cli's
 * actual architecture. Key integration decisions:
 *
 *   1. gemini-cli uses a Declarative Tool + Invocation pattern:
 *        BaseDeclarativeTool.createInvocation(params) → BaseToolInvocation
 *        invocation.shouldConfirmExecute(signal) → confirmation or false
 *        invocation.execute() → Promise<ToolResult>
 *      NOT: BaseTool.execute(params, signal)
 *
 *   2. GeminiChat.sendMessageStream() is request-response (one prompt → one stream).
 *      Voice mode is continuous (open WebSocket → multiple turns until closed).
 *      VoiceModeService replaces GeminiChat's role for voice sessions.
 *
 *   3. ToolRegistry works unchanged. FunctionDeclaration[] from getToolSchemas()
 *      passes directly to BidiGenerateContentSetup.tools[].
 *
 *   4. The Ink UI subscribes to VoiceModeEvents instead of GeminiStreamEvents.
 */

import { VoiceStateMachine, VoiceState } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";
import type { TranscriptSegment } from "./transcriptManager.js";
import { InterruptHandler } from "./interruptHandler.js";
import { GeminiLiveClient } from "./liveClient.js";
import type { ServerContentEvent, TranscriptionEvent } from "./liveClient.js";

// ═══════════════════════════════════════════════════════════════
// 1. TYPES MIRRORING GEMINI-CLI'S ACTUAL ARCHITECTURE
// ═══════════════════════════════════════════════════════════════
//
// Source: packages/core/src/tools/tools.ts
//
// gemini-cli recently moved to a declarative tool pattern where
// tool DEFINITIONS (schema, name) are separate from tool INVOCATIONS
// (execute, confirm). Each tool call creates a new invocation instance
// with its own parameters and lifecycle.
//
// See: BaseDeclarativeTool, BaseToolInvocation in tools.ts

/** From packages/core/src/tools/tools.ts — ToolResult */
interface ToolResult {
  llmContent?: string;
  returnDisplay?: string;
  error?: { message: string; type: string };
}

/** From packages/core/src/tools/tools.ts — ToolCallConfirmationDetails */
interface ToolCallConfirmationDetails {
  message: string;
  diff?: string;
}

/**
 * From packages/core/src/tools/tools.ts — BaseToolInvocation
 *
 * Each tool call creates an invocation instance. The invocation holds
 * the parameters and provides execute() + shouldConfirmExecute().
 *
 * Key: execute() does NOT take params — they're bound at construction.
 * It also does NOT take AbortSignal — cancellation is handled at the
 * scheduler level, not the invocation level. The scheduler races
 * execute() against the abort signal.
 */
interface ToolInvocation {
  getDescription(): string;
  shouldConfirmExecute(
    abortSignal: AbortSignal
  ): Promise<ToolCallConfirmationDetails | false>;
  execute(): Promise<ToolResult>;
}

/**
 * From packages/core/src/tools/tools.ts — BaseDeclarativeTool
 *
 * Registered once in ToolRegistry. Creates invocations on each call.
 */
interface DeclarativeTool {
  name: string;
  kind: "tool" | "invocableTool";
  getSchema(): FunctionDeclaration;
  createInvocation(params: Record<string, unknown>): ToolInvocation;
}

/** From packages/core/src/tools/tool-registry.ts — ToolRegistry */
interface ToolRegistry {
  registerTool(tool: DeclarativeTool): void;
  getTool(name: string): DeclarativeTool | undefined;
  getToolSchemas(): FunctionDeclaration[];
}

/** From @google/genai types */
interface FunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// 2. LiveToolExecutor — bridges gemini-cli tools to Live API
// ═══════════════════════════════════════════════════════════════
//
// Location: packages/core/src/voice/liveToolExecutor.ts
//
// This replaces CoreToolScheduler for voice sessions. Same pipeline:
//   validate → confirm → execute
// But confirmation is voice-based (audio prompt + VAD), and
// cancellation routes through InterruptHandler.

interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface LiveToolResult {
  id: string;
  name: string;
  response: Record<string, unknown>;
  cancelled: boolean;
}

/** Callback for voice-based tool confirmation. */
type VoiceConfirmCallback = (
  toolName: string,
  description: string,
  details: ToolCallConfirmationDetails
) => Promise<boolean>;

class LiveToolExecutor {
  private activeControllers = new Map<string, AbortController>();

  constructor(
    private registry: ToolRegistry,
    private interruptHandler: InterruptHandler,
    private onConfirmationNeeded?: VoiceConfirmCallback
  ) {}

  /**
   * Execute a tool call through gemini-cli's pipeline.
   *
   * Mirrors CoreToolScheduler's flow but adapted for voice:
   *   1. Look up DeclarativeTool in ToolRegistry
   *   2. Create invocation with params (just like the text-mode path)
   *   3. Check confirmation (voice prompt instead of diff display)
   *   4. Execute with AbortController cancellation
   */
  async execute(call: LiveToolCall): Promise<LiveToolResult> {
    const tool = this.registry.getTool(call.name);
    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        response: { error: `Unknown tool: ${call.name}` },
        cancelled: false,
      };
    }

    // Create invocation — same as CoreToolScheduler does
    const invocation = tool.createInvocation(call.args);

    // Set up AbortController and register with interrupt handler
    const controller = new AbortController();
    this.activeControllers.set(call.id, controller);
    this.interruptHandler.register({
      id: call.id,
      cancel: () => controller.abort(),
    });

    try {
      // Confirmation check. In text mode, this shows a diff.
      // In voice mode, we play an audio prompt and wait for voice yes/no.
      const confirmDetails = await invocation.shouldConfirmExecute(
        controller.signal
      );
      if (confirmDetails && this.onConfirmationNeeded) {
        const approved = await this.onConfirmationNeeded(
          call.name,
          invocation.getDescription(),
          confirmDetails
        );
        if (!approved) {
          return {
            id: call.id,
            name: call.name,
            response: { status: "denied_by_user" },
            cancelled: false,
          };
        }
      }

      // Execute. Race against AbortController.
      // ToolInvocation.execute() takes no AbortSignal parameter — in
      // gemini-cli, cancellation is handled at the scheduler level.
      // We race execute() against the abort signal so that even tools
      // that don't internally check for abort get cancelled promptly.
      const result = await Promise.race([
        invocation.execute(),
        new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        }),
      ]);

      return {
        id: call.id,
        name: call.name,
        response: result.error
          ? { error: result.error.message }
          : { content: result.llmContent ?? "success" },
        cancelled: false,
      };
    } catch (err: unknown) {
      const cancelled = err instanceof Error && err.name === "AbortError";
      return {
        id: call.id,
        name: call.name,
        response: cancelled
          ? { cancelled: true }
          : { error: String(err) },
        cancelled,
      };
    } finally {
      this.activeControllers.delete(call.id);
      this.interruptHandler.unregister(call.id);
    }
  }

  /**
   * Cancel specific tool calls by their IDs.
   * Used by toolCallCancellation — the server sends exact IDs of tools
   * to cancel, which may be a subset of active tools.
   */
  cancelByIds(ids: string[]): void {
    for (const id of ids) {
      const controller = this.activeControllers.get(id);
      if (controller) {
        controller.abort();
        this.activeControllers.delete(id);
        this.interruptHandler.unregister(id);
      }
    }
  }

  cancelAll(): void {
    for (const [, controller] of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  /** Number of tools currently executing. Used to coordinate TOOL_CALL_END. */
  get activeCallCount(): number {
    return this.activeControllers.size;
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. VoiceModeService — the actual integration surface
// ═══════════════════════════════════════════════════════════════
//
// Location: packages/core/src/voice/voiceModeService.ts
//
// This is what gemini-cli's CLI layer instantiates when the user
// runs `gemini --voice` or the `/voice` slash command.
//
// Unlike the previous empty-shell version, this contains the FULL
// orchestration logic: content event handling, transcription routing,
// model response buffering, and interrupt coordination.
//
// Architecture parallel:
//   Text mode:  GeminiClient → GeminiChat → sendMessageStream
//   Voice mode: GeminiClient → VoiceModeService → GeminiLiveClient

/** Events emitted to the CLI's Ink UI for rendering. */
interface VoiceModeEvent {
  type:
    | "state_change"
    | "transcript_update"
    | "model_text"
    | "tool_start"
    | "tool_end"
    | "interrupted"
    | "error"
    | "reconnected"
    | "session_end";
  data: unknown;
}

/** Config subset needed for voice mode. */
interface VoiceModeConfig {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
  usePushToTalk?: boolean;
}

/**
 * Callback to handle audio playback. Injected by the CLI layer
 * because audio hardware access lives in packages/cli, not packages/core.
 */
interface AudioHandler {
  queuePlayback(pcmBuffer: Buffer): void;
  stopPlayback(): void;
}

class VoiceModeService {
  // ── Core components ──────────────────────────────────────────
  private liveClient: GeminiLiveClient | null = null;
  private stateMachine: VoiceStateMachine;
  private transcript: TranscriptManager;
  private interruptHandler: InterruptHandler;
  private toolExecutor: LiveToolExecutor | null = null;

  // ── Orchestration state ──────────────────────────────────────
  // These mirror the variables in index.ts. They're the heart of
  // the orchestration — managing model response accumulation and
  // preventing double-counting between text content and transcription.
  private modelResponseBuffer = "";
  private receivedTextContent = false;

  // ── Cleanup handles ──────────────────────────────────────────
  // start() registers a stateMachine.onChange listener that must be
  // unsubscribed in stop(). Without this, start()→stop()→start()
  // would accumulate duplicate listeners, firing every state_change
  // event to the Ink UI multiple times.
  private unsubscribeStateChange: (() => void) | null = null;

  // ── Event system ─────────────────────────────────────────────
  private eventListeners: Array<(event: VoiceModeEvent) => void> = [];

  constructor(
    private config: VoiceModeConfig,
    private toolRegistry: ToolRegistry,
    private audio: AudioHandler
  ) {
    this.stateMachine = new VoiceStateMachine();
    this.transcript = new TranscriptManager();

    this.interruptHandler = new InterruptHandler(
      this.stateMachine,
      this.transcript,
      () => this.audio.stopPlayback(),
      () => this.liveClient?.sendInterrupt()
    );
  }

  // ── Event subscription (for Ink UI) ──────────────────────────

  /**
   * Ensure state machine has left LISTENING before processing model events.
   *
   * With server-side auto-VAD, there is no explicit "user stopped speaking"
   * signal. The first sign the model is responding is when content events
   * or tool calls arrive. This auto-transitions LISTENING → THINKING by
   * committing any pending user transcript and firing SPEECH_END.
   *
   * Safe to call multiple times — no-op if already past LISTENING.
   */
  private ensureModelTurn(): void {
    if (this.stateMachine.current === VoiceState.LISTENING) {
      const partialText = this.transcript.getPartial();
      if (partialText.trim()) {
        this.transcript.commitUser(partialText);
      }
      this.stateMachine.transition({
        type: "SPEECH_END",
        transcript: partialText || "",
      });
    }
  }

  /**
   * Subscribe to voice mode events.
   *
   * The CLI's useGeminiStream hook currently consumes events from
   * GeminiChat. In voice mode, useVoiceMode subscribes here instead.
   *
   * Event mapping from text mode:
   *   CHUNK (model text)    → model_text (streaming model speech text)
   *   ToolCallRequest       → tool_start
   *   ToolCallResult        → tool_end
   *   Finished              → session_end
   *   (no equivalent)       → state_change (new: drives waveform UI)
   *   (no equivalent)       → interrupted (new: barge-in notification)
   *   (no equivalent)       → reconnected (new: reset PTT/session UI state)
   */
  onEvent(listener: (event: VoiceModeEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private emit(event: VoiceModeEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /**
   * Start a voice session over the Live API WebSocket.
   *
   * Key difference from GeminiChat.sendMessageStream():
   *   sendMessageStream is one prompt → one response stream.
   *   VoiceModeService.start() opens a continuous bidirectional
   *   session with multiple turns until stop() is called.
   */
  async start(): Promise<void> {
    // Guard against double-start: if a session is already active, stop it
    // first to prevent leaking WebSocket connections and duplicate listeners.
    if (this.liveClient) {
      await this.stop();
    }

    this.liveClient = new GeminiLiveClient({
      apiKey: this.config.apiKey,
      model: this.config.model,
      voiceName: this.config.voiceName,
      systemInstruction: this.config.systemInstruction,
      manualVAD: this.config.usePushToTalk,
      autoReconnect: true,
      // Tool schemas from gemini-cli's ToolRegistry pass through unchanged.
      // FunctionDeclaration[] format is identical for standard and Live APIs.
      tools: this.toolRegistry.getToolSchemas().map((s) => ({
        name: s.name,
        description: s.description ?? "",
        parameters: s.parametersJsonSchema ?? {},
      })),
    });

    // Bridge: gemini-cli ToolRegistry → LiveToolExecutor
    this.toolExecutor = new LiveToolExecutor(
      this.toolRegistry,
      this.interruptHandler,
      // Voice confirmation: play audio prompt, wait for yes/no via VAD.
      // Production implementation would use the Live API's own audio output
      // to ask the confirmation question, then listen for user response.
      async (_toolName, _description, _details) => {
        // TODO: Implement audio-based confirmation flow.
        // For now: auto-approve (equivalent to --yolo flag).
        return true;
      }
    );

    // ── Wire state changes → UI events ──────────────────────────
    this.unsubscribeStateChange = this.stateMachine.onChange((from, to, event) => {
      this.emit({
        type: "state_change",
        data: { from, to, trigger: event.type },
      });
    });

    // ── Wire content events — THE CORE ORCHESTRATION LOGIC ──────
    //
    // This is NOT a thin wrapper. This is the actual stream coordination
    // that handles the three concurrent data paths:
    //   1. Model text/audio output → buffer + playback
    //   2. Turn signals → commit transcript + transition state
    //   3. Transcriptions → partial/committed transcript updates

    this.liveClient.on("content", (event: ServerContentEvent) => {
      switch (event.type) {
        case "text":
          // Model is streaming text content (text+audio mode).
          this.ensureModelTurn();
          if (this.stateMachine.current === VoiceState.THINKING) {
            this.stateMachine.transition({ type: "MODEL_STREAM_START" });
          }
          // On first text content event in this turn, discard any output
          // transcription that leaked into the buffer. The API spec says
          // transcription ordering is not guaranteed — if output transcription
          // arrived before this text event, the buffer has transcription text
          // that would be double-counted alongside the authoritative text.
          if (!this.receivedTextContent) {
            this.receivedTextContent = true;
            this.modelResponseBuffer = "";
          }
          this.modelResponseBuffer += event.text ?? "";
          this.emit({ type: "model_text", data: { text: event.text } });
          break;

        case "audio":
          // Model is streaming audio. Transition to SPEAKING if needed.
          this.ensureModelTurn();
          if (this.stateMachine.current === VoiceState.THINKING) {
            this.stateMachine.transition({ type: "MODEL_STREAM_START" });
          }
          if (event.audioData) {
            this.audio.queuePlayback(
              Buffer.from(event.audioData, "base64")
            );
          }
          break;

        case "turn_complete":
          // Model finished its response.
          if (this.modelResponseBuffer) {
            this.transcript.commitModel(this.modelResponseBuffer);
            this.modelResponseBuffer = "";
          }
          this.receivedTextContent = false;
          // Safe no-op if interrupt already moved us to LISTENING.
          this.stateMachine.transition({ type: "MODEL_STREAM_END" });
          this.emit({
            type: "transcript_update",
            data: { segments: this.transcript.getHistory() },
          });
          break;

        case "interrupted":
          // Server acknowledged interrupt. Commit partial as interrupted.
          if (this.modelResponseBuffer) {
            this.transcript.commitModel(this.modelResponseBuffer, true);
            this.modelResponseBuffer = "";
          }
          this.receivedTextContent = false;
          // Stop playback immediately — critical for server-initiated
          // interrupts where client-side energy detection hasn't fired.
          this.audio.stopPlayback();
          if (this.stateMachine.current !== VoiceState.LISTENING) {
            this.stateMachine.transition({ type: "INTERRUPT" });
          }
          this.emit({ type: "interrupted", data: {} });
          break;
      }
    });

    // ── Wire transcription events ───────────────────────────────
    this.liveClient.on("transcription", (event: TranscriptionEvent) => {
      if (event.direction === "input") {
        this.transcript.updatePartial(event.text);
        this.emit({
          type: "transcript_update",
          data: { partial: event.text },
        });
      } else {
        // Output transcription: only source of model text in audio-only mode.
        // Use += because chunks are incremental, not cumulative.
        if (!this.receivedTextContent) {
          this.modelResponseBuffer += event.text;
        }
      }
    });

    // ── Wire tool calls ─────────────────────────────────────────
    this.liveClient.on("toolCall", async (call) => {
      this.emit({
        type: "tool_start",
        data: { name: call.name, args: call.args },
      });

      this.ensureModelTurn();
      this.transcript.flushBeforeTool();
      this.stateMachine.transition({
        type: "TOOL_CALL_START",
        toolName: call.name,
        args: call.args,
      });

      const result = await this.toolExecutor!.execute(call);

      if (!result.cancelled) {
        // Only transition out of TOOL_EXEC when ALL parallel tools complete.
        if (this.toolExecutor!.activeCallCount === 0) {
          this.stateMachine.transition({
            type: "TOOL_CALL_END",
            result: result.response,
          });
        }
        // Always send individual responses back to the API.
        this.liveClient!.sendToolResponse(
          call.id,
          call.name,
          result.response
        );
        this.emit({ type: "tool_end", data: result });
      }
    });

    // ── Wire tool cancellation ──────────────────────────────────
    this.liveClient.on("toolCallCancellation", (event) => {
      // Cancel only the specific tools the server asked to cancel.
      // cancelAll() would be wrong — the model may cancel a subset of
      // parallel tools while expecting the rest to complete.
      this.toolExecutor!.cancelByIds(event.ids);
      // Defensive: if still in TOOL_EXEC after cancellation,
      // force transition. Message ordering not guaranteed.
      if (this.stateMachine.current === VoiceState.TOOL_EXEC) {
        this.audio.stopPlayback();
        this.stateMachine.transition({ type: "INTERRUPT" });
      }
    });

    // ── Wire errors ─────────────────────────────────────────────
    this.liveClient.on("error", (err) => {
      this.stateMachine.transition({ type: "ERROR", error: err });
      this.emit({ type: "error", data: { message: err.message } });
    });

    // ── Wire disconnect (state cleanup for reconnect) ───────────
    // After auto-reconnect, a fresh Live API session starts. Reset
    // local state so we don't carry stale FSM/buffer from the old session.
    // Note: session resumption (BidiGenerateContentSetup.sessionResumption)
    // could preserve server-side context across reconnects — that's a
    // future enhancement once the API stabilizes.
    this.liveClient.on("disconnected", () => {
      this.toolExecutor?.cancelAll();
      this.audio.stopPlayback();
      if (this.modelResponseBuffer) {
        this.transcript.commitModel(this.modelResponseBuffer, true);
        this.modelResponseBuffer = "";
      }
      this.receivedTextContent = false;
      this.stateMachine.reset();
    });

    this.liveClient.on("goAway", (event) => {
      this.emit({
        type: "error",
        data: {
          message: `Server disconnecting in ${event.timeLeftMs}ms. Reconnecting...`,
          recoverable: true,
        },
      });
    });

    // ── Wire setupComplete (defensive reset on (re)connect) ─────
    // Fires on both initial connect and reconnect. A fresh Live API
    // session means local state (buffers, FSM, pending tools) must
    // be reset. The disconnected handler does this too, but setupComplete
    // catches edge cases where the WebSocket closes and reopens so fast
    // that message ordering makes disconnected fire after setupComplete.
    this.liveClient.on("setupComplete", () => {
      this.stateMachine.reset();
      this.toolExecutor?.cancelAll();
      this.audio.stopPlayback();
      this.modelResponseBuffer = "";
      this.receivedTextContent = false;
      // Notify the CLI layer that a fresh session started. Critical for PTT:
      // the useVoiceMode hook owns holdingPtt, and after reconnect the server
      // has no memory of a pending activityStart. Without this event,
      // holdingPtt stays true and the next space press sends activityEnd
      // with no matching activityStart — the server rejects it.
      this.emit({ type: "reconnected", data: {} });
    });

    // ── Connect ─────────────────────────────────────────────────
    await this.liveClient.connect();
  }

  // ── Audio input (called by the CLI's audio capture layer) ────

  /** Forward mic audio to the Live API. Call continuously in all states. */
  sendAudio(pcmBuffer: Buffer): void {
    this.liveClient?.sendAudio(pcmBuffer);
  }

  /**
   * Client-side interrupt detection from mic energy.
   * Supplements server-side VAD for lower-latency barge-in.
   */
  checkInterrupt(audioEnergy: number): void {
    if (
      !this.config.usePushToTalk &&
      this.interruptHandler.shouldInterrupt(audioEnergy)
    ) {
      this.interruptHandler.interrupt();
    }
  }

  // ── PTT signals ──────────────────────────────────────────────

  sendActivityStart(): void {
    this.liveClient?.sendActivityStart();
  }

  sendActivityEnd(): void {
    this.liveClient?.sendActivityEnd();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async stop(): Promise<string> {
    // Cancel in-flight tools before disconnecting — their abort
    // signals fire synchronously, preventing stale tool responses
    // from being sent after the WebSocket closes.
    this.toolExecutor?.cancelAll();
    this.audio.stopPlayback();

    this.liveClient?.disconnect();
    this.liveClient = null;
    this.toolExecutor = null;

    // Commit any partial model response as interrupted BEFORE
    // capturing the transcript — otherwise the returned text
    // is missing whatever the model was streaming when stop() fired.
    if (this.modelResponseBuffer) {
      this.transcript.commitModel(this.modelResponseBuffer, true);
    }

    const text = this.transcript.toPlainText();

    // Reset orchestration state so a subsequent start() doesn't
    // inherit stale buffers from this session.
    this.modelResponseBuffer = "";
    this.receivedTextContent = false;
    this.stateMachine.reset();

    // Remove the onChange listener registered in start(). Without
    // this, start()→stop()→start() would fire every state_change
    // event twice to the Ink UI.
    if (this.unsubscribeStateChange) {
      this.unsubscribeStateChange();
      this.unsubscribeStateChange = null;
    }

    this.emit({ type: "session_end", data: {} });
    return text;
  }

  // ── Queries (for UI rendering) ───────────────────────────────

  getState(): VoiceState {
    return this.stateMachine.current;
  }

  getTranscript(): readonly TranscriptSegment[] {
    return this.transcript.getHistory();
  }

  getPartialTranscript(): string {
    return this.transcript.getPartial();
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. WHERE THIS SLOTS INTO GEMINI-CLI
// ═══════════════════════════════════════════════════════════════
//
// packages/core/src/voice/
// ├── voiceModeService.ts    ← VoiceModeService (this file's main class)
// ├── liveClient.ts          ← GeminiLiveClient (WebSocket to Live API)
// ├── stateMachine.ts        ← VoiceStateMachine (4-state FSM)
// ├── transcriptManager.ts   ← TranscriptManager (partial/committed)
// ├── interruptHandler.ts    ← InterruptHandler (barge-in coordination)
// ├── liveToolExecutor.ts    ← LiveToolExecutor (bridges ToolRegistry)
// └── audioIO.ts             ← AudioIO (mic/speaker via PortAudio)
//
// packages/cli/src/ui/
// ├── components/VoiceMode.tsx  ← Ink component (waveform + transcript)
// └── hooks/useVoiceMode.ts    ← React hook wrapping VoiceModeService
//
// ┌─────────────────────────────────────────────────────────────┐
// │ What changes in the existing codebase                       │
// ├─────────────────────────────────────────────────────────────┤
// │                                                             │
// │ packages/core/src/core/client.ts (GeminiClient)             │
// │   Add: createVoiceSession(config) → VoiceModeService        │
// │   GeminiClient already holds ToolRegistry + Config.         │
// │   It passes them to GeminiChat today; for voice mode it     │
// │   passes them to VoiceModeService instead.                  │
// │                                                             │
// │ packages/core/src/tools/tool-registry.ts (ToolRegistry)     │
// │   NO CHANGES. VoiceModeService consumes getToolSchemas()    │
// │   and getTool() exactly as CoreToolScheduler does.          │
// │                                                             │
// │ packages/core/src/tools/tools.ts (BaseDeclarativeTool)      │
// │   NO CHANGES. The createInvocation → execute pattern works  │
// │   identically for voice. AbortSignal already threaded       │
// │   through shouldConfirmExecute.                             │
// │                                                             │
// │ packages/core/src/config/config.ts (Config)                 │
// │   Add: voice mode settings                                  │
// │     voiceMode: { enabled, ptt, voiceName, vadThreshold }    │
// │                                                             │
// │ packages/cli/src/ui/hooks/useGeminiStream.ts                │
// │   Detect --voice flag → delegate to useVoiceMode.ts         │
// │   useVoiceMode subscribes to VoiceModeEvent instead of      │
// │   GeminiStreamEvent.                                        │
// │                                                             │
// │ packages/cli/src/index.ts or nonInteractiveCli.ts           │
// │   Add --voice CLI flag, audio hardware detection            │
// │                                                             │
// └─────────────────────────────────────────────────────────────┘

export { VoiceModeService, LiveToolExecutor };
export type {
  VoiceModeConfig,
  VoiceModeEvent,
  AudioHandler,
  LiveToolCall,
  LiveToolResult,
  DeclarativeTool,
  ToolInvocation,
  ToolRegistry,
  ToolResult,
  FunctionDeclaration,
  VoiceConfirmCallback,
};
