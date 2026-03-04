/**
 * Transcript Consistency Layer
 *
 * Problem: The Live API emits *partial* transcripts that get revised.
 * If a tool call fires based on a partial transcript that later changes,
 * we get inconsistent state.
 *
 * Solution: Two-tier transcript model.
 *   partial  — latest ASR hypothesis, may change at any time
 *   committed — finalised transcript segments (after endpoint / turn_complete)
 *
 * On interrupt:
 *   - partial is discarded
 *   - committed history is preserved
 *   - pending tool calls that depended on the partial are marked stale
 */

export interface TranscriptSegment {
  id: string;
  role: "user" | "model";
  text: string;
  timestamp: number;
  /** Was this segment interrupted before completion? */
  interrupted: boolean;
}

export class TranscriptManager {
  private committed: TranscriptSegment[] = [];
  private partial: string = "";
  private segmentCounter = 0;

  // ── Partial transcript (live ASR hypothesis) ─────────────────

  updatePartial(text: string): void {
    this.partial = text;
  }

  getPartial(): string {
    return this.partial;
  }

  // ── Commit (finalise a segment) ──────────────────────────────

  /**
   * Promote current partial to a committed segment.
   * Called when the Live API signals turn_complete or endpoint.
   */
  commitUser(finalText?: string): TranscriptSegment {
    const seg: TranscriptSegment = {
      id: `seg-${++this.segmentCounter}`,
      role: "user",
      text: finalText ?? this.partial,
      timestamp: Date.now(),
      interrupted: false,
    };
    this.committed.push(seg);
    this.partial = "";
    return seg;
  }

  commitModel(text: string, interrupted = false): TranscriptSegment {
    const seg: TranscriptSegment = {
      id: `seg-${++this.segmentCounter}`,
      role: "model",
      text,
      timestamp: Date.now(),
      interrupted,
    };
    this.committed.push(seg);
    return seg;
  }

  // ── Flush / Rollback ─────────────────────────────────────────

  /**
   * Called before a tool invocation to ensure we operate on
   * committed state only. Returns the latest committed user text.
   */
  flushBeforeTool(): string | null {
    if (this.partial.trim()) {
      this.commitUser();
    }
    const last = this.committed.filter((s) => s.role === "user").at(-1);
    return last?.text ?? null;
  }

  /**
   * Called on barge-in / interrupt.
   * Discards partial transcript.
   *
   * Note: We do NOT mark model segments here. The interrupted model response
   * is committed via commitModel(text, true) in the "interrupted" content
   * event handler. Marking the last committed segment here would incorrectly
   * flag a PREVIOUS turn's completed response as interrupted in multi-turn
   * conversations.
   */
  rollbackOnInterrupt(): void {
    this.partial = "";
  }

  // ── Query ────────────────────────────────────────────────────

  getHistory(): readonly TranscriptSegment[] {
    return this.committed;
  }

  getLastUserText(): string | null {
    return (
      this.committed
        .filter((s) => s.role === "user")
        .at(-1)?.text ?? null
    );
  }

  /** Full conversation as a plain string (useful for debugging). */
  toPlainText(): string {
    return this.committed
      .map(
        (s) =>
          `[${s.role.toUpperCase()}${s.interrupted ? " ✂" : ""}] ${s.text}`
      )
      .join("\n");
  }

  clear(): void {
    this.committed = [];
    this.partial = "";
    this.segmentCounter = 0;
  }
}
