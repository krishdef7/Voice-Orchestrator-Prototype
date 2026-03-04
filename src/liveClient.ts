/**
 * Gemini Live API Client
 *
 * Direct WebSocket connection to BidiGenerateContent.
 * Uses Gemini's native multimodal audio streaming — NOT a Whisper wrapper.
 *
 * Protocol (camelCase JSON over WebSocket):
 *   Client → Server: setup, clientContent, realtimeInput, toolResponse
 *   Server → Client: setupComplete, serverContent, toolCall,
 *                     toolCallCancellation, goAway
 *
 * Reference: https://ai.google.dev/api/live
 */

import WebSocket from "ws";
import { EventEmitter } from "events";

// ── Types ────────────────────────────────────────────────────────

export interface LiveClientConfig {
  apiKey: string;
  model?: string;
  voiceName?: string;
  systemInstruction?: string;
  /** If true, disable server-side VAD (for push-to-talk mode). */
  manualVAD?: boolean;
  /** If true, automatically reconnect on unexpected disconnection. */
  autoReconnect?: boolean;
  /** Max reconnection attempts before giving up (default: 5). */
  maxReconnectAttempts?: number;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface ServerContentEvent {
  type: "text" | "audio" | "turn_complete" | "interrupted";
  text?: string;
  audioData?: string; // base64 PCM
  audioMimeType?: string;
}

export interface TranscriptionEvent {
  direction: "input" | "output";
  text: string;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallCancellationEvent {
  ids: string[];
}

export interface GoAwayEvent {
  timeLeftMs: number;
}

export interface LiveClientEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  setupComplete: [];
  content: [event: ServerContentEvent];
  transcription: [event: TranscriptionEvent];
  toolCall: [event: ToolCallEvent];
  toolCallCancellation: [event: ToolCallCancellationEvent];
  goAway: [event: GoAwayEvent];
  error: [error: Error];
}

// ── Client ───────────────────────────────────────────────────────

export class GeminiLiveClient extends EventEmitter<LiveClientEvents> {
  private ws: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Required<
    Pick<LiveClientConfig, "apiKey" | "model" | "voiceName" | "manualVAD" | "autoReconnect" | "maxReconnectAttempts">
  > &
    LiveClientConfig;

  constructor(config: LiveClientConfig) {
    super();
    this.config = {
      // gemini-2.0-flash-live-001 was SHUT DOWN December 9, 2025.
      // https://ai.google.dev/gemini-api/docs/changelog
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
      voiceName: "Puck",
      manualVAD: false,
      autoReconnect: false,
      maxReconnectAttempts: 5,
      ...config,
    };
  }

  // ── Connection ────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;

    const url =
      `wss://generativelanguage.googleapis.com/ws/` +
      `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
      `?key=${this.config.apiKey}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = () => {
        settled = true;
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
      };

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        this.emit("connected");
        this.sendSetup();
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);

          if (msg.setupComplete && !settled) {
            settle();
            this.emit("setupComplete");
            resolve();
          }
        } catch (err) {
          this.emit("error", err as Error);
        }
      });

      this.ws.on("error", (err) => {
        this.emit("error", err as Error);
        if (!settled) {
          settle();
          reject(err);
        }
      });

      this.ws.on("close", (code, reason) => {
        this.emit("disconnected", code, reason.toString());
        // Auto-reconnect on unexpected disconnection.
        // Don't reconnect if the user called disconnect() intentionally.
        if (
          this.config.autoReconnect &&
          !this.intentionalDisconnect &&
          this.reconnectAttempts < this.config.maxReconnectAttempts
        ) {
          this.scheduleReconnect();
        }
      });

      this.connectTimer = setTimeout(() => {
        if (!settled) {
          settle();
          reject(new Error("Connection timeout (10s)"));
          this.ws?.close();
        }
      }, 10_000);
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    // Reset reconnect counter so the next connect() starts fresh.
    // Without this, after exhausting maxReconnectAttempts (5 failures),
    // disconnect() → connect() leaves reconnectAttempts=5, and the next
    // unexpected close won't auto-reconnect (5 < 5 = false).
    this.reconnectAttempts = 0;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Backoff: 1s, 2s, 4s, 8s, 16s (capped at 30s).
   */
  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;

    this.emit(
      "error",
      new Error(
        `Connection lost. Reconnecting in ${delay}ms ` +
          `(attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`
      )
    );

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectAttempts = 0; // Reset on success
      } catch {
        // connect() failure will trigger another close → scheduleReconnect
      }
    }, delay);
  }

  // ── Send setup (camelCase per API spec) ───────────────────────

  private sendSetup(): void {
    const setupMsg: Record<string, unknown> = {
      model: `models/${this.config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO", "TEXT"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voiceName,
            },
          },
        },
      },
      // Enable audio transcription for both directions.
      // Server sends inputTranscription / outputTranscription in serverContent.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    // System instruction
    if (this.config.systemInstruction) {
      setupMsg.systemInstruction = {
        parts: [{ text: this.config.systemInstruction }],
      };
    }

    // Tool declarations
    if (this.config.tools?.length) {
      setupMsg.tools = [
        {
          functionDeclarations: this.config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    // Manual VAD for push-to-talk mode.
    // When disabled, the client must send activityStart/activityEnd signals.
    // https://ai.google.dev/gemini-api/docs/live-guide
    if (this.config.manualVAD) {
      setupMsg.realtimeInputConfig = {
        automaticActivityDetection: { disabled: true },
      };
    }

    this.send({ setup: setupMsg });
  }

  // ── Audio streaming ───────────────────────────────────────────

  /**
   * Stream a chunk of PCM audio to the Live API.
   * Audio format: 16-bit PCM, 16kHz, mono.
   *
   * Uses the `audio` field (not deprecated `mediaChunks`).
   */
  sendAudio(pcmBuffer: Buffer): void {
    this.send({
      realtimeInput: {
        audio: {
          data: pcmBuffer.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }

  // ── Activity signals (for manual VAD / push-to-talk) ──────────

  /**
   * Signal start of user speech. Required when manualVAD is true.
   * Call when the PTT button is pressed.
   */
  sendActivityStart(): void {
    this.send({
      realtimeInput: { activityStart: {} },
    });
  }

  /**
   * Signal end of user speech. Required when manualVAD is true.
   * Call when the PTT button is released.
   */
  sendActivityEnd(): void {
    this.send({
      realtimeInput: { activityEnd: {} },
    });
  }

  // ── Turn management ───────────────────────────────────────────

  /**
   * Signal end of user turn via clientContent (for text input mode only).
   *
   * For audio with auto-VAD, the server detects end-of-speech automatically.
   * For audio with manual VAD (PTT), use sendActivityEnd() instead.
   *
   * Note: Do NOT include an empty turns array — that would inject an empty
   * user message into the conversation history, wasting context.
   */
  sendEndOfTurn(): void {
    this.send({
      clientContent: {
        turnComplete: true,
      },
    });
  }

  /**
   * Interrupt current model generation.
   *
   * Per the API spec: "A [clientContent] message will interrupt any
   * current model generation."
   *
   * Implementation note: this sends the same wire message as sendEndOfTurn()
   * because the Live API protocol uses clientContent.turnComplete for both
   * purposes. We keep separate methods for semantic clarity at call sites.
   */
  sendInterrupt(): void {
    this.sendEndOfTurn();
  }

  // ── Tool responses ────────────────────────────────────────────

  /**
   * Send tool result back to the model.
   *
   * The `response` field is a google.protobuf.Struct (plain JSON object).
   * Do NOT stringify it — the API expects the actual object, not a JSON string.
   *
   * `id` matches responses to the corresponding tool call.
   * `name` is the function name from the original FunctionCall.
   */
  sendToolResponse(
    callId: string,
    functionName: string,
    result: unknown
  ): void {
    // Ensure result is an object for the Struct field. Primitives get wrapped.
    const responseObj =
      typeof result === "object" && result !== null
        ? result
        : { result };

    this.send({
      toolResponse: {
        functionResponses: [
          {
            id: callId,
            name: functionName,
            response: responseObj,
          },
        ],
      },
    });
  }

  // ── Handle incoming messages ──────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    // Setup complete — handled in connect()
    if (msg.setupComplete) return;

    // Server content (text / audio / turn signals / transcriptions)
    const serverContent = msg.serverContent as
      | Record<string, unknown>
      | undefined;
    if (serverContent) {
      // Process transcriptions FIRST — they are independent fields that
      // can coexist with turnComplete/interrupted in the same message.
      // Per API docs: "The transcription is sent independently of the
      // other server messages and there is no guaranteed ordering."
      const inputTx = serverContent.inputTranscription as
        | { text: string }
        | undefined;
      if (inputTx?.text) {
        this.emit("transcription", {
          direction: "input",
          text: inputTx.text,
        });
      }

      const outputTx = serverContent.outputTranscription as
        | { text: string }
        | undefined;
      if (outputTx?.text) {
        this.emit("transcription", {
          direction: "output",
          text: outputTx.text,
        });
      }

      // Parse model output parts BEFORE turn signals.
      // turnComplete and modelTurn.parts are separate fields on serverContent.
      // The API can send the final content chunk and turnComplete in the same
      // WebSocket frame. If we early-return on turnComplete first, the last
      // chunk of text/audio would be silently dropped.
      const modelTurn = serverContent.modelTurn as
        | { parts: Array<Record<string, unknown>> }
        | undefined;
      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          if (part.text) {
            this.emit("content", {
              type: "text",
              text: part.text as string,
            });
          }
          if (part.inlineData) {
            const inlineData = part.inlineData as {
              data: string;
              mimeType: string;
            };
            this.emit("content", {
              type: "audio",
              audioData: inlineData.data,
              audioMimeType: inlineData.mimeType,
            });
          }
        }
      }

      // Turn signals — processed AFTER parts so content is never dropped.
      if (serverContent.turnComplete) {
        this.emit("content", { type: "turn_complete" });
        return;
      }

      if (serverContent.interrupted) {
        this.emit("content", { type: "interrupted" });
        return;
      }

      return;
    }

    // Tool calls
    const toolCall = msg.toolCall as
      | {
          functionCalls: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
          }>;
        }
      | undefined;
    if (toolCall?.functionCalls) {
      for (const fc of toolCall.functionCalls) {
        this.emit("toolCall", {
          id: fc.id,
          name: fc.name,
          args: fc.args ?? {},
        });
      }
      return;
    }

    // Tool call cancellation — server tells us to cancel in-flight tools.
    // Sent when the user interrupts during tool execution.
    const cancellation = msg.toolCallCancellation as
      | { ids: string[] }
      | undefined;
    if (cancellation?.ids) {
      this.emit("toolCallCancellation", { ids: cancellation.ids });
      return;
    }

    // GoAway — server will disconnect soon. Client should reconnect.
    // timeLeft is a google.protobuf.Duration with {seconds, nanos}.
    const goAway = msg.goAway as
      | { timeLeft: { seconds?: number; nanos?: number } }
      | undefined;
    if (goAway) {
      const seconds = goAway.timeLeft?.seconds ?? 0;
      const nanos = goAway.timeLeft?.nanos ?? 0;
      const timeLeftMs = Number(seconds) * 1000 + Math.floor(Number(nanos) / 1_000_000);
      this.emit("goAway", { timeLeftMs });
      return;
    }
  }

  // ── Util ──────────────────────────────────────────────────────

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
