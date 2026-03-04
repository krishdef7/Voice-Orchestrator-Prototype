/**
 * TranscriptManager Unit Tests
 *
 * Tests the two-tier transcript model (partial/committed),
 * interrupt rollback semantics, and tool flush consistency.
 *
 * Run: npx tsx src/transcriptManager.test.ts
 */

import { TranscriptManager } from "./transcriptManager.js";

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

// ── Partial transcript ─────────────────────────────────────────

console.log("── Partial Transcript ──────────────────────────────────");

{
  const tm = new TranscriptManager();
  assert("Initial partial is empty", tm.getPartial(), "");

  tm.updatePartial("hel");
  assert("Partial updates", tm.getPartial(), "hel");

  tm.updatePartial("hello world");
  assert("Partial replaces (not appends)", tm.getPartial(), "hello world");
}

// ── Commit user ────────────────────────────────────────────────

console.log("── Commit User ────────────────────────────────────────");

{
  const tm = new TranscriptManager();
  tm.updatePartial("test input");
  const seg = tm.commitUser();

  assert("commitUser uses partial text", seg.text, "test input");
  assert("commitUser role is user", seg.role, "user");
  assert("commitUser not interrupted", seg.interrupted, false);
  assert("Partial cleared after commit", tm.getPartial(), "");
  assert("History has 1 segment", tm.getHistory().length, 1);
}

{
  const tm = new TranscriptManager();
  tm.updatePartial("partial text");
  const seg = tm.commitUser("final text");

  assert("commitUser prefers finalText over partial", seg.text, "final text");
  assert("Partial still cleared", tm.getPartial(), "");
}

// ── Commit model ───────────────────────────────────────────────

console.log("── Commit Model ───────────────────────────────────────");

{
  const tm = new TranscriptManager();
  const seg = tm.commitModel("model response");

  assert("commitModel text", seg.text, "model response");
  assert("commitModel role is model", seg.role, "model");
  assert("commitModel not interrupted by default", seg.interrupted, false);
}

{
  const tm = new TranscriptManager();
  const seg = tm.commitModel("partial response", true);

  assert("commitModel interrupted flag", seg.interrupted, true);
}

// ── Segment IDs are unique ─────────────────────────────────────

console.log("── Segment IDs ────────────────────────────────────────");

{
  const tm = new TranscriptManager();
  const s1 = tm.commitUser("a");
  const s2 = tm.commitModel("b");
  const s3 = tm.commitUser("c");

  assert("IDs are unique (s1 != s2)", s1.id !== s2.id, true);
  assert("IDs are unique (s2 != s3)", s2.id !== s3.id, true);
}

// ── flushBeforeTool ────────────────────────────────────────────

console.log("── flushBeforeTool ────────────────────────────────────");

{
  const tm = new TranscriptManager();
  tm.updatePartial("read README");
  const lastUser = tm.flushBeforeTool();

  assert(
    "flushBeforeTool commits pending partial",
    tm.getHistory().length,
    1
  );
  assert("flushBeforeTool returns committed text", lastUser, "read README");
  assert("Partial empty after flush", tm.getPartial(), "");
}

{
  const tm = new TranscriptManager();
  tm.commitUser("first question");
  tm.commitModel("first answer");
  tm.updatePartial("second question");
  const lastUser = tm.flushBeforeTool();

  assert("flushBeforeTool returns LATEST user text", lastUser, "second question");
  assert("History now has 3 segments", tm.getHistory().length, 3);
}

{
  const tm = new TranscriptManager();
  const result = tm.flushBeforeTool();

  assert("flushBeforeTool on empty returns null", result, null);
}

{
  const tm = new TranscriptManager();
  tm.updatePartial("   ");
  const result = tm.flushBeforeTool();

  assert("flushBeforeTool ignores whitespace-only partial", result, null);
  assert("Whitespace partial not committed", tm.getHistory().length, 0);
}

// ── rollbackOnInterrupt ────────────────────────────────────────

console.log("── rollbackOnInterrupt ────────────────────────────────");

{
  const tm = new TranscriptManager();
  tm.updatePartial("in progress...");
  tm.rollbackOnInterrupt();

  assert("rollbackOnInterrupt clears partial", tm.getPartial(), "");
}

{
  // THE CRITICAL TEST: rollback does NOT corrupt previous turns
  const tm = new TranscriptManager();
  tm.commitUser("question 1");
  tm.commitModel("answer 1");
  tm.commitUser("question 2");
  tm.commitModel("answer 2");

  // Now during a third exchange, interrupt happens
  tm.updatePartial("question 3 in progr...");
  tm.rollbackOnInterrupt();

  const history = tm.getHistory();
  assert("Previous segments preserved", history.length, 4);
  assert("answer 1 NOT marked interrupted", history[1].interrupted, false);
  assert("answer 2 NOT marked interrupted", history[3].interrupted, false);
}

// ── getLastUserText ────────────────────────────────────────────

console.log("── getLastUserText ────────────────────────────────────");

{
  const tm = new TranscriptManager();
  assert("getLastUserText empty returns null", tm.getLastUserText(), null);

  tm.commitUser("first");
  tm.commitModel("response");
  tm.commitUser("second");

  assert("getLastUserText returns latest", tm.getLastUserText(), "second");
}

// ── toPlainText ────────────────────────────────────────────────

console.log("── toPlainText ────────────────────────────────────────");

{
  const tm = new TranscriptManager();
  tm.commitUser("hello");
  tm.commitModel("hi there");
  tm.commitModel("partial resp", true);
  tm.commitUser("new question");

  const text = tm.toPlainText();
  assert(
    "toPlainText format correct",
    text,
    "[USER] hello\n[MODEL] hi there\n[MODEL ✂] partial resp\n[USER] new question"
  );
}

// ── Multi-turn full scenario ───────────────────────────────────

console.log("── Multi-turn Scenario ────────────────────────────────");

{
  const tm = new TranscriptManager();

  // Turn 1: normal
  tm.updatePartial("read the README");
  tm.commitUser("read the README file");
  tm.commitModel("The README describes...");

  // Turn 2: interrupted
  tm.updatePartial("explain the arch");
  tm.commitUser("explain the architecture");
  // Model starts streaming but gets interrupted:
  tm.commitModel("The architecture uses a streaming state", true);

  // Turn 3: after interrupt, new question
  tm.updatePartial("what about tools");
  const flushed = tm.flushBeforeTool();

  assert("Flushed text after interrupt", flushed, "what about tools");
  assert("Total segments: 5", tm.getHistory().length, 5);

  const text = tm.toPlainText();
  const lines = text.split("\n");
  assert("5 lines in transcript", lines.length, 5);
  assert("Line 4 has interrupt marker", lines[3].includes("✂"), true);
  assert("Line 1 no interrupt marker", lines[0].includes("✂"), false);
}

// ── clear ──────────────────────────────────────────────────────

console.log("── clear ──────────────────────────────────────────────");

{
  const tm = new TranscriptManager();
  tm.commitUser("test");
  tm.updatePartial("partial");
  tm.clear();

  assert("clear empties history", tm.getHistory().length, 0);
  assert("clear empties partial", tm.getPartial(), "");
}

// ── Results ────────────────────────────────────────────────────

console.log(
  `\n════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n════════════════════════════════════════════════════`
);
if (failed > 0) process.exit(1);
