/**
 * ToolOrchestrator Unit Tests
 *
 * Tests tool registration, AbortController-gated execution,
 * cancellation mid-flight, unknown tool handling, and cancelAll().
 *
 * Run: npx tsx src/toolOrchestrator.test.ts
 */

import { VoiceStateMachine } from "./stateMachine.js";
import { TranscriptManager } from "./transcriptManager.js";
import { InterruptHandler } from "./interruptHandler.js";
import { ToolOrchestrator, ToolDefinition } from "./toolOrchestrator.js";

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

function setup() {
  const sm = new VoiceStateMachine();
  const tm = new TranscriptManager();
  const ih = new InterruptHandler(sm, tm, () => {}, () => {});
  const to = new ToolOrchestrator(ih);
  return { sm, tm, ih, to };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tool registration ──────────────────────────────────────────

console.log("── Tool Registration ──────────────────────────────────");

{
  const { to } = setup();

  const tool: ToolDefinition = {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  };

  to.registerTool(tool);

  const declarations = to.getToolDeclarations();
  assert("1 tool declared", declarations.length, 1);
  assert("Declaration name", declarations[0].name, "test_tool");
  assert("Declaration description", declarations[0].description, "A test tool");
}

// ── Successful execution ───────────────────────────────────────

console.log("── Successful Execution ───────────────────────────────");

{
  const { to } = setup();
  let receivedSignal: AbortSignal | null = null;

  to.registerTool({
    name: "echo",
    description: "Echoes args",
    parameters: {},
    execute: async (args, signal) => {
      receivedSignal = signal;
      return { echoed: args.message };
    },
  });

  const result = await to.execute("echo", { message: "hello" });

  assert("Result not cancelled", result.cancelled, false);
  assert("Result has correct output", JSON.stringify(result.result), JSON.stringify({ echoed: "hello" }));
  assert("Tool name recorded", result.toolName, "echo");
  assert("Duration is positive", result.durationMs >= 0, true);
  assert("Signal was provided", receivedSignal !== null, true);
  assert("Signal not aborted", receivedSignal!.aborted, false);
  assert("Active calls back to 0", to.activeCallCount, 0);
}

// ── Unknown tool ───────────────────────────────────────────────

console.log("── Unknown Tool ───────────────────────────────────────");

{
  const { to } = setup();
  const result = await to.execute("nonexistent", {});

  assert("Unknown tool not cancelled", result.cancelled, false);
  assert(
    "Unknown tool returns error",
    JSON.stringify(result.result),
    JSON.stringify({ error: "Unknown tool: nonexistent" })
  );
  assert("Duration is 0", result.durationMs, 0);
}

// ── Tool that throws ───────────────────────────────────────────

console.log("── Tool Error Handling ─────────────────────────────────");

{
  const { to } = setup();

  to.registerTool({
    name: "failing",
    description: "Always fails",
    parameters: {},
    execute: async () => {
      throw new Error("disk full");
    },
  });

  const result = await to.execute("failing", {});

  assert("Error tool not cancelled", result.cancelled, false);
  assert(
    "Error captured in result",
    JSON.stringify(result.result),
    JSON.stringify({ error: "Error: disk full" })
  );
}

// ── Cancellation via interrupt ─────────────────────────────────

console.log("── Cancellation via interrupt ────────────────────────");

{
  const { ih, to } = setup();
  // Drive state machine to SPEAKING so interrupt works
  const sm = (ih as any).stateMachine as VoiceStateMachine;
  sm.transition({ type: "SPEECH_END", transcript: "t" });
  sm.transition({ type: "MODEL_STREAM_START" });

  to.registerTool({
    name: "slow_tool",
    description: "Slow",
    parameters: {},
    execute: async (_args, signal) => {
      for (let i = 0; i < 50; i++) {
        await sleep(20);
        signal.throwIfAborted();
      }
      return { done: true };
    },
  });

  // Start tool execution (non-blocking)
  const resultPromise = to.execute("slow_tool", {});

  // Let it run briefly, then interrupt
  await sleep(100);
  assert("Tool is active", to.activeCallCount, 1);

  ih.interrupt();

  const result = await resultPromise;
  assert("Cancelled flag true", result.cancelled, true);
  assert("Active calls cleared", to.activeCallCount, 0);
  assert("Duration > 0", result.durationMs > 0, true);
}

// ── cancelAll() ────────────────────────────────────────────────

console.log("── cancelAll() ────────────────────────────────────────");

{
  const { to } = setup();
  let tool1Done = false;
  let tool2Done = false;

  to.registerTool({
    name: "t1",
    description: "tool1",
    parameters: {},
    execute: async (_args, signal) => {
      await sleep(500);
      signal.throwIfAborted();
      tool1Done = true;
      return {};
    },
  });

  to.registerTool({
    name: "t2",
    description: "tool2",
    parameters: {},
    execute: async (_args, signal) => {
      await sleep(500);
      signal.throwIfAborted();
      tool2Done = true;
      return {};
    },
  });

  const p1 = to.execute("t1", {});
  const p2 = to.execute("t2", {});
  await sleep(50);

  assert("2 active calls", to.activeCallCount, 2);
  to.cancelAll();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert("t1 cancelled", r1.cancelled, true);
  assert("t2 cancelled", r2.cancelled, true);
  assert("Neither actually completed", tool1Done || tool2Done, false);
}

// ── Cleanup after success ──────────────────────────────────────

console.log("── Cleanup ────────────────────────────────────────────");

{
  const { ih, to } = setup();

  to.registerTool({
    name: "fast",
    description: "Fast",
    parameters: {},
    execute: async () => ({ ok: true }),
  });

  await to.execute("fast", {});

  assert("No active calls after success", to.activeCallCount, 0);
  assert("No pending ops in interrupt handler", ih.pendingOperationCount, 0);
}

// ── cancelByIds (selective cancellation) ────────────────────────

console.log("── cancelByIds (selective cancellation) ───────────────");

{
  const { to } = setup();

  let toolAFinished = false;
  let toolBFinished = false;

  to.registerTool({
    name: "toolA",
    description: "Slow tool A",
    parameters: {},
    execute: async (_args, signal) => {
      await new Promise((r, rej) => {
        const t = setTimeout(r, 500);
        signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
      toolAFinished = true;
      return { a: true };
    },
  });

  to.registerTool({
    name: "toolB",
    description: "Slow tool B",
    parameters: {},
    execute: async (_args, signal) => {
      await new Promise((r, rej) => {
        const t = setTimeout(r, 500);
        signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
      toolBFinished = true;
      return { b: true };
    },
  });

  // Start both tools with specific API call IDs
  const promiseA = to.execute("toolA", {}, "api-call-A");
  const promiseB = to.execute("toolB", {}, "api-call-B");

  assert("Two active calls", to.activeCallCount, 2);

  // Cancel only tool A — tool B should continue
  to.cancelByIds(["api-call-A"]);
  assert("One active call after selective cancel", to.activeCallCount, 1);

  const resultA = await promiseA;
  assert("Tool A was cancelled", resultA.cancelled, true);

  const resultB = await promiseB;
  assert("Tool B completed successfully", resultB.cancelled, false);
  assert("Tool B returned result", (resultB.result as any).b, true);
  assert("Tool A never finished executing", toolAFinished, false);
  assert("Tool B finished executing", toolBFinished, true);
  assert("Zero active calls after both complete", to.activeCallCount, 0);
}

{
  const { to } = setup();

  to.registerTool({
    name: "x",
    description: "X",
    parameters: {},
    execute: async () => ({ x: 1 }),
  });

  // cancelByIds with non-existent ID should not throw
  to.cancelByIds(["nonexistent-id"]);
  assert("cancelByIds with unknown ID is no-op", to.activeCallCount, 0);
}

// ── Results ────────────────────────────────────────────────────

console.log(
  `\n════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n════════════════════════════════════════════════════`
);
if (failed > 0) process.exit(1);
