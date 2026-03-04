/**
 * Streaming Voice State Machine
 *
 * Models voice interaction as a continuous stream with four states.
 * Transitions are driven by real-time events (audio input, model
 * output, tool calls, interrupts).
 *
 * Key design property: resolve() is a pure function —
 * deterministic mapping from (currentState, event) → nextState.
 * No side effects, no hidden state reads. Trivially unit-testable.
 *
 * Key invariant: INTERRUPT is valid from any non-LISTENING state.
 * This guarantees barge-in always works.
 */

export enum VoiceState {
  /** Mic is live, VAD is active, waiting for speech. */
  LISTENING = "LISTENING",
  /** User utterance received, model is generating. */
  THINKING = "THINKING",
  /** Model response is streaming back (audio / text). */
  SPEAKING = "SPEAKING",
  /** A tool call is in-flight (file op, shell cmd, etc.). */
  TOOL_EXEC = "TOOL_EXEC",
}

export type StateTransitionEvent =
  | { type: "SPEECH_START" }
  | { type: "SPEECH_END"; transcript: string }
  | { type: "MODEL_STREAM_START" }
  | { type: "MODEL_STREAM_END" }
  | { type: "TOOL_CALL_START"; toolName: string; args: Record<string, unknown> }
  | { type: "TOOL_CALL_END"; result: unknown }
  | { type: "INTERRUPT" }
  | { type: "ERROR"; error: Error };

export type StateChangeCallback = (
  from: VoiceState,
  to: VoiceState,
  event: StateTransitionEvent
) => void;

export class VoiceStateMachine {
  private state: VoiceState = VoiceState.LISTENING;
  private listeners: StateChangeCallback[] = [];

  get current(): VoiceState {
    return this.state;
  }

  onChange(cb: StateChangeCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /**
   * Process an event and return the new state.
   * Invalid transitions are silently ignored — real-time systems
   * must never throw on stale events from concurrent streams.
   */
  transition(event: StateTransitionEvent): VoiceState {
    const prev = this.state;
    const next = this.resolve(prev, event);

    if (next !== null && next !== prev) {
      this.state = next;
      for (const cb of this.listeners) cb(prev, next, event);
    }

    return this.state;
  }

  /**
   * Pure transition function. No side effects, no instance state reads.
   *
   * (currentState, event) → nextState | null
   *
   * Returns null when the transition is invalid for the current state.
   * This is public so it can be unit-tested directly.
   */
  resolve(
    state: VoiceState,
    event: StateTransitionEvent
  ): VoiceState | null {
    switch (event.type) {
      // ── Interrupt (highest priority — any non-LISTENING state) ──
      case "INTERRUPT":
        return state === VoiceState.LISTENING ? null : VoiceState.LISTENING;

      // ── Speech ──────────────────────────────────────────────────
      case "SPEECH_START":
        // User starts speaking. If SPEAKING/THINKING/TOOL_EXEC → barge-in.
        // If already LISTENING, no-op.
        return state === VoiceState.LISTENING ? null : VoiceState.LISTENING;

      case "SPEECH_END":
        return state === VoiceState.LISTENING ? VoiceState.THINKING : null;

      // ── Model stream ────────────────────────────────────────────
      case "MODEL_STREAM_START":
        return state === VoiceState.THINKING ? VoiceState.SPEAKING : null;

      case "MODEL_STREAM_END":
        return state === VoiceState.SPEAKING ? VoiceState.LISTENING : null;

      // ── Tool execution ──────────────────────────────────────────
      // TOOL_CALL_START is valid from THINKING, SPEAKING, and TOOL_EXEC.
      // The Live API can send multiple FunctionCalls in a single message,
      // so we must handle entering TOOL_EXEC when already in TOOL_EXEC.
      case "TOOL_CALL_START":
        return state === VoiceState.THINKING ||
          state === VoiceState.SPEAKING ||
          state === VoiceState.TOOL_EXEC
          ? VoiceState.TOOL_EXEC
          : null;

      case "TOOL_CALL_END":
        return state === VoiceState.TOOL_EXEC ? VoiceState.SPEAKING : null;

      // ── Error → reset ───────────────────────────────────────────
      case "ERROR":
        return VoiceState.LISTENING;

      default:
        return null;
    }
  }

  reset(): void {
    const prev = this.state;
    this.state = VoiceState.LISTENING;
    if (prev !== VoiceState.LISTENING) {
      for (const cb of this.listeners)
        cb(prev, VoiceState.LISTENING, { type: "INTERRUPT" });
    }
  }
}
