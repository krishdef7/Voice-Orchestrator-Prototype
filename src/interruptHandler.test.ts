/**
 * InterruptHandler Unit Tests
 *
 * Tests barge-in coordination: operation cancellation, execution order,
 * shouldInterrupt thresholding across states, and LISTENING no-op.
 *
 * Run: npx tsx src/interruptHandler.test.ts
 */

import { VoiceStateMachine, VoiceState } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";
import { InterruptHandler, CancellableOperation } from "./interruptHandler.js";

let passed = 0;
let failed = 0;

function assert(desc: string, actual: unknown, expected: unknown): void {
  const pass =
    typeof actual === "object" && typeof expected === "object"
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected;
  if (pass) {
    passed++;
  } else {
    failed++;
    console.error(
      `  ✗ ${desc}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function setup(initialState?: VoiceState) {
  const sm = new VoiceStateMachine();
  const tm = new TranscriptManager();
  const calls: string[] = [];

  // Drive to desired state
  if (initialState === VoiceState.THINKING) {
    sm.transition({ type: "SPEECH_END", transcript: "test" });
  } else if (initialState === VoiceState.SPEAKING) {
    sm.transition({ type: "SPEECH_END", transcript: "test" });
    sm.transition({ type: "MODEL_STREAM_START" });
  } else if (initialState === VoiceState.TOOL_EXEC) {
    sm.transition({ type: "SPEECH_END", transcript: "test" });
    sm.transition({ type: "TOOL_CALL_START", toolName: "t", args: {} });
  }

  const ih = new InterruptHandler(
    sm,
    tm,
    () => calls.push("stopPlayback"),
    () => calls.push("cancelGeneration")
  );

  return { sm, tm, ih, calls };
}

// ── shouldInterrupt ────────────────────────────────────────────

console.log("── shouldInterrupt ────────────────────────────────────");

{
  const { ih } = setup(VoiceState.LISTENING);
  assert("LISTENING: no interrupt", ih.shouldInterrupt(0.5), false);
}

{
  const { ih } = setup(VoiceState.SPEAKING);
  assert("SPEAKING + high energy: interrupt", ih.shouldInterrupt(0.5), true);
  assert("SPEAKING + low energy: no interrupt", ih.shouldInterrupt(0.001), false);
}

{
  const { ih } = setup(VoiceState.THINKING);
  assert("THINKING + high energy: interrupt", ih.shouldInterrupt(0.5), true);
}

{
  const { ih } = setup(VoiceState.TOOL_EXEC);
  assert("TOOL_EXEC + high energy: interrupt", ih.shouldInterrupt(0.5), true);
}

{
  const { ih } = setup(VoiceState.SPEAKING);
  assert("Custom threshold: below", ih.shouldInterrupt(0.05, 0.1), false);
  assert("Custom threshold: above", ih.shouldInterrupt(0.15, 0.1), true);
}

// ── interrupt() execution order ────────────────────────────────

console.log("── interrupt() execution order ────────────────────────");

{
  const { sm, ih, calls } = setup(VoiceState.SPEAKING);

  ih.interrupt();

  assert("stopPlayback called first", calls[0], "stopPlayback");
  assert("cancelGeneration called second", calls[1], "cancelGeneration");
  assert("State transitions to LISTENING", sm.current, VoiceState.LISTENING);
}

// ── interrupt() from LISTENING is no-op ────────────────────────

console.log("── interrupt() no-op from LISTENING ──────────────────");

{
  const { sm, ih, calls } = setup(VoiceState.LISTENING);

  ih.interrupt();

  assert("No callbacks called", calls.length, 0);
  assert("State stays LISTENING", sm.current, VoiceState.LISTENING);
}

// ── interrupt() cancels registered operations ──────────────────

console.log("── Operation cancellation ─────────────────────────────");

{
  const { ih } = setup(VoiceState.SPEAKING);
  const cancelled: string[] = [];

  const op1: CancellableOperation = {
    id: "op1",
    cancel: () => cancelled.push("op1"),
  };
  const op2: CancellableOperation = {
    id: "op2",
    cancel: () => cancelled.push("op2"),
  };

  ih.register(op1);
  ih.register(op2);
  assert("2 pending operations", ih.pendingOperationCount, 2);

  ih.interrupt();

  assert("Both operations cancelled", cancelled.length, 2);
  assert("op1 cancelled", cancelled.includes("op1"), true);
  assert("op2 cancelled", cancelled.includes("op2"), true);
  assert("Operations cleared after interrupt", ih.pendingOperationCount, 0);
}

// ── register / unregister ──────────────────────────────────────

console.log("── register / unregister ──────────────────────────────");

{
  const { ih } = setup(VoiceState.SPEAKING);

  ih.register({ id: "a", cancel: () => {} });
  ih.register({ id: "b", cancel: () => {} });
  assert("2 registered", ih.pendingOperationCount, 2);

  ih.unregister("a");
  assert("1 after unregister", ih.pendingOperationCount, 1);

  ih.unregister("nonexistent");
  assert("Unregister nonexistent is safe", ih.pendingOperationCount, 1);
}

// ── interrupt() clears partial transcript ──────────────────────

console.log("── Transcript rollback on interrupt ──────────────────");

{
  const { tm, ih } = setup(VoiceState.SPEAKING);
  tm.updatePartial("in progress...");

  ih.interrupt();

  assert("Partial cleared after interrupt", tm.getPartial(), "");
}

// ── interrupt() from each non-LISTENING state ──────────────────

console.log("── interrupt() from all states ───────────────────────");

for (const state of [VoiceState.THINKING, VoiceState.SPEAKING, VoiceState.TOOL_EXEC]) {
  const { sm, ih, calls } = setup(state);
  ih.interrupt();
  assert(`${state} → LISTENING`, sm.current, VoiceState.LISTENING);
  assert(`${state}: callbacks fired`, calls.length, 2);
}

// ── Results ────────────────────────────────────────────────────

console.log(
  `\n════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n════════════════════════════════════════════════════`
);
if (failed > 0) process.exit(1);
