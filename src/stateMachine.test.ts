/**
 * State Machine Unit Tests
 *
 * Tests the pure resolve() function directly — no mocking needed.
 * Run: npx tsx src/stateMachine.test.ts
 */

import { VoiceStateMachine, VoiceState } from "./stateMachine.js";

let passed = 0;
let failed = 0;

function assert(
  desc: string,
  actual: VoiceState | null,
  expected: VoiceState | null
): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${desc}: expected ${expected}, got ${actual}`);
  }
}

function assertEq(desc: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${desc}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const sm = new VoiceStateMachine();

console.log("── Normal Flow ──────────────────────────────────────");

assert(
  "LISTENING + SPEECH_END → THINKING",
  sm.resolve(VoiceState.LISTENING, { type: "SPEECH_END", transcript: "hello" }),
  VoiceState.THINKING
);

assert(
  "THINKING + MODEL_STREAM_START → SPEAKING",
  sm.resolve(VoiceState.THINKING, { type: "MODEL_STREAM_START" }),
  VoiceState.SPEAKING
);

assert(
  "SPEAKING + MODEL_STREAM_END → LISTENING",
  sm.resolve(VoiceState.SPEAKING, { type: "MODEL_STREAM_END" }),
  VoiceState.LISTENING
);

console.log("── Tool Flow ───────────────────────────────────────");

assert(
  "THINKING + TOOL_CALL_START → TOOL_EXEC",
  sm.resolve(VoiceState.THINKING, {
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: {},
  }),
  VoiceState.TOOL_EXEC
);

assert(
  "SPEAKING + TOOL_CALL_START → TOOL_EXEC",
  sm.resolve(VoiceState.SPEAKING, {
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: {},
  }),
  VoiceState.TOOL_EXEC
);

assert(
  "TOOL_EXEC + TOOL_CALL_END → SPEAKING",
  sm.resolve(VoiceState.TOOL_EXEC, { type: "TOOL_CALL_END", result: {} }),
  VoiceState.SPEAKING
);

console.log("── Interrupt (barge-in) ─────────────────────────────");

assert(
  "SPEAKING + INTERRUPT → LISTENING",
  sm.resolve(VoiceState.SPEAKING, { type: "INTERRUPT" }),
  VoiceState.LISTENING
);

assert(
  "THINKING + INTERRUPT → LISTENING",
  sm.resolve(VoiceState.THINKING, { type: "INTERRUPT" }),
  VoiceState.LISTENING
);

assert(
  "TOOL_EXEC + INTERRUPT → LISTENING",
  sm.resolve(VoiceState.TOOL_EXEC, { type: "INTERRUPT" }),
  VoiceState.LISTENING
);

assert(
  "LISTENING + INTERRUPT → null (no-op)",
  sm.resolve(VoiceState.LISTENING, { type: "INTERRUPT" }),
  null
);

console.log("── SPEECH_START (barge-in trigger) ──────────────────");

assert(
  "SPEAKING + SPEECH_START → LISTENING",
  sm.resolve(VoiceState.SPEAKING, { type: "SPEECH_START" }),
  VoiceState.LISTENING
);

assert(
  "THINKING + SPEECH_START → LISTENING",
  sm.resolve(VoiceState.THINKING, { type: "SPEECH_START" }),
  VoiceState.LISTENING
);

assert(
  "LISTENING + SPEECH_START → null (already listening)",
  sm.resolve(VoiceState.LISTENING, { type: "SPEECH_START" }),
  null
);

console.log("── Invalid transitions (must return null) ──────────");

assert(
  "LISTENING + MODEL_STREAM_START → null",
  sm.resolve(VoiceState.LISTENING, { type: "MODEL_STREAM_START" }),
  null
);

assert(
  "SPEAKING + SPEECH_END → null (stale)",
  sm.resolve(VoiceState.SPEAKING, { type: "SPEECH_END", transcript: "" }),
  null
);

assert(
  "LISTENING + TOOL_CALL_START → null",
  sm.resolve(VoiceState.LISTENING, {
    type: "TOOL_CALL_START",
    toolName: "x",
    args: {},
  }),
  null
);

assert(
  "THINKING + TOOL_CALL_END → null",
  sm.resolve(VoiceState.THINKING, { type: "TOOL_CALL_END", result: {} }),
  null
);

console.log("── Error recovery ──────────────────────────────────");

assert(
  "SPEAKING + ERROR → LISTENING",
  sm.resolve(VoiceState.SPEAKING, {
    type: "ERROR",
    error: new Error("test"),
  }),
  VoiceState.LISTENING
);

assert(
  "TOOL_EXEC + ERROR → LISTENING",
  sm.resolve(VoiceState.TOOL_EXEC, {
    type: "ERROR",
    error: new Error("test"),
  }),
  VoiceState.LISTENING
);

// ── Integration: transition() with callbacks ─────────────────

console.log("── Integration: transition() + callbacks ───────────");

const sm2 = new VoiceStateMachine();
const transitions: string[] = [];
sm2.onChange((from, to) => transitions.push(`${from}→${to}`));

sm2.transition({ type: "SPEECH_END", transcript: "hello" });
sm2.transition({ type: "MODEL_STREAM_START" });
sm2.transition({ type: "INTERRUPT" }); // barge-in

assert(
  "After barge-in, state is LISTENING",
  sm2.current,
  VoiceState.LISTENING
);

const expectedTransitions = [
  "LISTENING→THINKING",
  "THINKING→SPEAKING",
  "SPEAKING→LISTENING",
];

if (
  transitions.length === expectedTransitions.length &&
  transitions.every((t, i) => t === expectedTransitions[i])
) {
  passed++;
} else {
  failed++;
  console.error(
    `  ✗ Transition history: expected ${JSON.stringify(expectedTransitions)}, got ${JSON.stringify(transitions)}`
  );
}

// ── Auto-VAD Flow (ensureModelTurn pattern) ─────────────────

console.log("── Auto-VAD: LISTENING → SPEECH_END → MODEL_STREAM ──");

{
  // In auto-VAD mode, there's no explicit "user stopped speaking" event.
  // The runtime fires SPEECH_END when the first content event arrives
  // (via ensureModelTurn), then MODEL_STREAM_START immediately after.
  // This test validates the state machine handles this rapid sequence.
  const sm = new VoiceStateMachine();
  assert(
    "Auto-VAD starts in LISTENING",
    sm.current,
    VoiceState.LISTENING
  );

  // ensureModelTurn() fires SPEECH_END when content arrives in LISTENING
  sm.transition({ type: "SPEECH_END", transcript: "" });
  assert(
    "SPEECH_END → THINKING",
    sm.current,
    VoiceState.THINKING
  );

  // Immediately followed by MODEL_STREAM_START
  sm.transition({ type: "MODEL_STREAM_START" });
  assert(
    "MODEL_STREAM_START → SPEAKING",
    sm.current,
    VoiceState.SPEAKING
  );

  // Barge-in is now possible
  sm.transition({ type: "INTERRUPT" });
  assert(
    "INTERRUPT → LISTENING",
    sm.current,
    VoiceState.LISTENING
  );

  // Second turn: same rapid sequence
  sm.transition({ type: "SPEECH_END", transcript: "second query" });
  sm.transition({ type: "MODEL_STREAM_START" });
  assert(
    "Second turn reaches SPEAKING",
    sm.current,
    VoiceState.SPEAKING
  );

  sm.transition({ type: "MODEL_STREAM_END" });
  assert(
    "MODEL_STREAM_END → LISTENING",
    sm.current,
    VoiceState.LISTENING
  );
}

console.log("── Auto-VAD: tool call from LISTENING ────────────────");

{
  // Tool calls can also arrive while in LISTENING (auto-VAD mode).
  // ensureModelTurn fires SPEECH_END first, then TOOL_CALL_START
  // can transition from THINKING.
  const sm = new VoiceStateMachine();

  sm.transition({ type: "SPEECH_END", transcript: "" });
  assert("→ THINKING", sm.current, VoiceState.THINKING);

  sm.transition({
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: { path: "a.ts" },
  });
  assert("→ TOOL_EXEC", sm.current, VoiceState.TOOL_EXEC);

  sm.transition({ type: "TOOL_CALL_END", result: {} });
  assert("→ SPEAKING", sm.current, VoiceState.SPEAKING);

  sm.transition({ type: "MODEL_STREAM_END" });
  assert("→ LISTENING", sm.current, VoiceState.LISTENING);
}

// ── Parallel tool calls ─────────────────────────────────────

console.log("── Parallel tool calls (TOOL_CALL_START from TOOL_EXEC) ──");

{
  const sm = new VoiceStateMachine();
  sm.transition({ type: "SPEECH_END", transcript: "test" });
  sm.transition({
    type: "TOOL_CALL_START",
    toolName: "read_file",
    args: { path: "a.ts" },
  });
  assert("First tool → TOOL_EXEC", sm.current, VoiceState.TOOL_EXEC);

  // Second tool call arrives while first is still running
  const result = sm.resolve(VoiceState.TOOL_EXEC, {
    type: "TOOL_CALL_START",
    toolName: "search_code",
    args: { query: "bug" },
  });
  assert(
    "TOOL_CALL_START from TOOL_EXEC → TOOL_EXEC (not null)",
    result,
    VoiceState.TOOL_EXEC
  );

  sm.transition({
    type: "TOOL_CALL_START",
    toolName: "search_code",
    args: { query: "bug" },
  });
  assert("Still in TOOL_EXEC", sm.current, VoiceState.TOOL_EXEC);
}

// ── Reset method ────────────────────────────────────────────

console.log("── reset() method ────────────────────────────────────");

{
  const sm = new VoiceStateMachine();
  sm.transition({ type: "SPEECH_END", transcript: "test" });
  assert("Pre-reset in THINKING", sm.current, VoiceState.THINKING);

  const changes: Array<{ from: VoiceState; to: VoiceState }> = [];
  sm.onChange((from, to) => changes.push({ from, to }));

  sm.reset();
  assert("Reset returns to LISTENING", sm.current, VoiceState.LISTENING);
  assertEq("Reset fires callback", changes.length, 1);
  assert("Callback from THINKING", changes[0].from, VoiceState.THINKING);
  assert("Callback to LISTENING", changes[0].to, VoiceState.LISTENING);
}

{
  const sm = new VoiceStateMachine();
  const changes: Array<{ from: VoiceState; to: VoiceState }> = [];
  sm.onChange((from, to) => changes.push({ from, to }));

  // Reset from LISTENING is no-op
  sm.reset();
  assertEq("Reset from LISTENING is no-op", changes.length, 0);
  assert("Still LISTENING", sm.current, VoiceState.LISTENING);
}

// ── Summary ──────────────────────────────────────────────────

console.log(`\n${"═".repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(52)}`);

if (failed > 0) process.exit(1);
