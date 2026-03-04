/**
 * Interrupt Engine
 *
 * Barge-in is the hardest problem in voice agents:
 *   - Model is streaming audio output
 *   - User starts speaking
 *   - We must: stop playback, cancel generation, flush transcript,
 *     cancel pending tools, and transition to LISTENING — atomically.
 *
 * This module coordinates that cross-cutting concern.
 */

import { VoiceStateMachine, VoiceState } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";

export interface CancellableOperation {
  id: string;
  cancel(): void;
}

export class InterruptHandler {
  private activeCancellables: Map<string, CancellableOperation> = new Map();

  constructor(
    private stateMachine: VoiceStateMachine,
    private transcript: TranscriptManager,
    private onStopPlayback: () => void,
    private onCancelGeneration: () => void
  ) {}

  /**
   * Register an in-flight operation (model stream, tool call)
   * that should be cancelled on interrupt.
   */
  register(op: CancellableOperation): void {
    this.activeCancellables.set(op.id, op);
  }

  unregister(id: string): void {
    this.activeCancellables.delete(id);
  }

  /**
   * Execute a full interrupt sequence.
   * Called when VAD detects user speech during any active state.
   *
   * Order matters:
   *  1. Stop audio playback (user hears silence immediately)
   *  2. Cancel model generation (stop wasting tokens)
   *  3. Cancel pending tool calls
   *  4. Rollback transcript
   *  5. Transition state machine
   */
  interrupt(): void {
    const currentState = this.stateMachine.current;

    // Only interrupt if we're actually doing something
    if (currentState === VoiceState.LISTENING) {
      return;
    }

    // 1. Stop playback — lowest latency action first
    this.onStopPlayback();

    // 2. Cancel model generation
    this.onCancelGeneration();

    // 3. Cancel all registered operations
    for (const [, op] of this.activeCancellables) {
      op.cancel();
    }
    this.activeCancellables.clear();

    // 4. Rollback transcript
    this.transcript.rollbackOnInterrupt();

    // 5. State transition
    this.stateMachine.transition({ type: "INTERRUPT" });
  }

  /**
   * Check if we should trigger interrupt based on audio input energy.
   *
   * FIX: Now includes THINKING — if the model is generating and the
   * user speaks, barge-in must fire before audio output even starts.
   */
  shouldInterrupt(audioEnergy: number, threshold = 0.02): boolean {
    const state = this.stateMachine.current;
    return (
      (state === VoiceState.SPEAKING ||
        state === VoiceState.THINKING ||
        state === VoiceState.TOOL_EXEC) &&
      audioEnergy > threshold
    );
  }

  get pendingOperationCount(): number {
    return this.activeCancellables.size;
  }
}
