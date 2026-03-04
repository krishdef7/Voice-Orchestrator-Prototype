/**
 * GeminiLiveClient Protocol Tests
 *
 * Tests message parsing, event emission, setup construction, and
 * tool response serialization without requiring a live WebSocket.
 *
 * Strategy: We can't test connect() without a real server, but we CAN
 * test handleMessage() (the protocol parser) and verify that outbound
 * messages are correctly structured by intercepting send().
 *
 * We use a lightweight subclass that exposes protected internals.
 *
 * Run: npx tsx src/liveClient.test.ts
 */

import { GeminiLiveClient, LiveClientConfig } from "./liveClient.js";

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
      `  ✗ ${desc}:\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(actual)}`
    );
  }
}

/**
 * TestableClient exposes handleMessage for testing protocol parsing
 * and intercepts send() for outbound message format verification —
 * both without requiring a live WebSocket connection.
 */
class TestableClient extends GeminiLiveClient {
  /** Captured outbound messages (from send calls) */
  outbound: unknown[] = [];

  constructor(config?: Partial<LiveClientConfig>) {
    super({ apiKey: "test-key", ...config });
    // Intercept the private send() method to capture outbound messages.
    // In production, send() writes to WebSocket. In tests, we capture
    // the JSON payload for format verification.
    (this as any).send = (data: unknown) => {
      this.outbound.push(data);
    };
  }

  /** Expose the private handleMessage for testing */
  injectServerMessage(msg: Record<string, unknown>): void {
    (this as any).handleMessage(msg);
  }
}

// ═════════════════════════════════════════════════════════════════
// MESSAGE PARSING (handleMessage)
// ═════════════════════════════════════════════════════════════════

console.log("── Server Content: Text ───────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ type: string; text?: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      modelTurn: {
        parts: [{ text: "Hello world" }],
      },
    },
  });

  assert("Emits text content event", events.length, 1);
  assert("Event type is text", events[0].type, "text");
  assert("Event contains text", events[0].text, "Hello world");
}

console.log("── Server Content: Audio ──────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ type: string; audioData?: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: "AQIDBA==",
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
  });

  assert("Emits audio content event", events.length, 1);
  assert("Event type is audio", events[0].type, "audio");
  assert("Event contains base64 audio", events[0].audioData, "AQIDBA==");
}

console.log("── Server Content: Mixed parts ───────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ type: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      modelTurn: {
        parts: [
          { text: "Let me check" },
          { inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } },
        ],
      },
    },
  });

  assert("Emits 2 events for mixed parts", events.length, 2);
  assert("First is text", events[0].type, "text");
  assert("Second is audio", events[1].type, "audio");
}

console.log("── Server Content: Turn Complete ─────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ type: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: { turnComplete: true },
  });

  assert("Emits turn_complete", events.length, 1);
  assert("Event type is turn_complete", events[0].type, "turn_complete");
}

console.log("── Server Content: turnComplete + parts in same msg ──");

{
  // The API can bundle the final content chunk with turnComplete in one
  // WebSocket frame. Parts must be processed BEFORE the turnComplete
  // signal — otherwise the last word of the response is silently dropped.
  const client = new TestableClient();
  const events: Array<{ type: string; text?: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      modelTurn: { parts: [{ text: "final words" }] },
      turnComplete: true,
    },
  });

  assert("Both text and turn_complete emitted", events.length, 2);
  assert("Text emitted first", events[0].type, "text");
  assert("Text content preserved", events[0].text, "final words");
  assert("turn_complete emitted second", events[1].type, "turn_complete");
}

console.log("── Server Content: Interrupted ───────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ type: string }> = [];
  client.on("content", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: { interrupted: true },
  });

  assert("Emits interrupted", events.length, 1);
  assert("Event type is interrupted", events[0].type, "interrupted");
}

// ═════════════════════════════════════════════════════════════════
// CRITICAL BUG FIX VERIFICATION: Transcriptions before turn signals
// ═════════════════════════════════════════════════════════════════

console.log("── Transcription + turnComplete in same message ──────");

{
  const client = new TestableClient();
  const contentEvents: Array<{ type: string }> = [];
  const txEvents: Array<{ direction: string; text: string }> = [];
  client.on("content", (e) => contentEvents.push(e));
  client.on("transcription", (e) => txEvents.push(e));

  // The Live API can send transcription AND turnComplete in the same
  // serverContent message. If turnComplete were checked first with an
  // early return, transcription would be lost. This was a bug found in
  // the v3 audit — verify the fix is still correct.
  client.injectServerMessage({
    serverContent: {
      inputTranscription: { text: "what about tools" },
      turnComplete: true,
    },
  });

  assert("Transcription NOT lost", txEvents.length, 1);
  assert("Transcription text correct", txEvents[0].text, "what about tools");
  assert("turn_complete also emitted", contentEvents.length, 1);
  assert("turn_complete type correct", contentEvents[0].type, "turn_complete");
}

console.log("── Output transcription with interrupted ─────────────");

{
  const client = new TestableClient();
  const contentEvents: Array<{ type: string }> = [];
  const txEvents: Array<{ direction: string; text: string }> = [];
  client.on("content", (e) => contentEvents.push(e));
  client.on("transcription", (e) => txEvents.push(e));

  client.injectServerMessage({
    serverContent: {
      outputTranscription: { text: "The architecture uses a str" },
      interrupted: true,
    },
  });

  assert("Output tx not lost on interrupt", txEvents.length, 1);
  assert("Output tx direction correct", txEvents[0].direction, "output");
  assert("Interrupted also emitted", contentEvents.length, 1);
}

// ═════════════════════════════════════════════════════════════════
// TRANSCRIPTION EVENTS
// ═════════════════════════════════════════════════════════════════

console.log("── Input Transcription ────────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ direction: string; text: string }> = [];
  client.on("transcription", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      inputTranscription: { text: "read the readme" },
    },
  });

  assert("Input transcription emitted", events.length, 1);
  assert("Direction is input", events[0].direction, "input");
  assert("Text matches", events[0].text, "read the readme");
}

console.log("── Output Transcription ───────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ direction: string; text: string }> = [];
  client.on("transcription", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      outputTranscription: { text: "The README describes" },
    },
  });

  assert("Output transcription emitted", events.length, 1);
  assert("Direction is output", events[0].direction, "output");
}

// ═════════════════════════════════════════════════════════════════
// TOOL CALLS
// ═════════════════════════════════════════════════════════════════

console.log("── Tool Call Parsing ───────────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  client.on("toolCall", (e) => events.push(e));

  client.injectServerMessage({
    toolCall: {
      functionCalls: [
        {
          id: "fc-001",
          name: "read_file",
          args: { path: "README.md" },
        },
      ],
    },
  });

  assert("Tool call emitted", events.length, 1);
  assert("Tool call id", events[0].id, "fc-001");
  assert("Tool call name", events[0].name, "read_file");
  assert("Tool call args", JSON.stringify(events[0].args), JSON.stringify({ path: "README.md" }));
}

console.log("── Multiple tool calls in single message ─────────────");

{
  const client = new TestableClient();
  const events: Array<{ name: string }> = [];
  client.on("toolCall", (e) => events.push(e));

  client.injectServerMessage({
    toolCall: {
      functionCalls: [
        { id: "fc-001", name: "read_file", args: { path: "a.ts" } },
        { id: "fc-002", name: "search_code", args: { query: "bug" } },
      ],
    },
  });

  assert("Both tool calls emitted", events.length, 2);
  assert("First tool name", events[0].name, "read_file");
  assert("Second tool name", events[1].name, "search_code");
}

console.log("── Tool call with missing args defaults to {} ────────");

{
  const client = new TestableClient();
  const events: Array<{ args: Record<string, unknown> }> = [];
  client.on("toolCall", (e) => events.push(e));

  client.injectServerMessage({
    toolCall: {
      functionCalls: [
        { id: "fc-001", name: "list_tools" },
      ],
    },
  });

  assert("Args default to empty object", JSON.stringify(events[0].args), JSON.stringify({}));
}

// ═════════════════════════════════════════════════════════════════
// TOOL CALL CANCELLATION
// ═════════════════════════════════════════════════════════════════

console.log("── Tool Call Cancellation ────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ ids: string[] }> = [];
  client.on("toolCallCancellation", (e) => events.push(e));

  client.injectServerMessage({
    toolCallCancellation: { ids: ["fc-001", "fc-002"] },
  });

  assert("Cancellation emitted", events.length, 1);
  assert("Cancelled IDs", JSON.stringify(events[0].ids), JSON.stringify(["fc-001", "fc-002"]));
}

// ═════════════════════════════════════════════════════════════════
// GO AWAY
// ═════════════════════════════════════════════════════════════════

console.log("── GoAway ─────────────────────────────────────────────");

{
  const client = new TestableClient();
  const events: Array<{ timeLeftMs: number }> = [];
  client.on("goAway", (e) => events.push(e));

  client.injectServerMessage({
    goAway: { timeLeft: { seconds: 30 } },
  });

  assert("GoAway emitted", events.length, 1);
  assert("Time converted to ms", events[0].timeLeftMs, 30000);
}

console.log("── GoAway with nanos (sub-second precision) ───────────");

{
  const client = new TestableClient();
  const events: Array<{ timeLeftMs: number }> = [];
  client.on("goAway", (e) => events.push(e));

  // google.protobuf.Duration uses {seconds, nanos}
  // 5 seconds + 500,000,000 nanos = 5500ms
  client.injectServerMessage({
    goAway: { timeLeft: { seconds: 5, nanos: 500_000_000 } },
  });

  assert("GoAway with nanos emitted", events.length, 1);
  assert("Nanos included in ms", events[0].timeLeftMs, 5500);
}

console.log("── GoAway with only nanos (no seconds) ────────────────");

{
  const client = new TestableClient();
  const events: Array<{ timeLeftMs: number }> = [];
  client.on("goAway", (e) => events.push(e));

  client.injectServerMessage({
    goAway: { timeLeft: { nanos: 750_000_000 } },
  });

  assert("GoAway nanos-only", events.length, 1);
  assert("750ms from nanos", events[0].timeLeftMs, 750);
}

// ═════════════════════════════════════════════════════════════════
// SETUP COMPLETE
// ═════════════════════════════════════════════════════════════════

console.log("── setupComplete ignored (handled in connect) ────────");

{
  const client = new TestableClient();
  const contentEvents: Array<unknown> = [];
  client.on("content", (e) => contentEvents.push(e));
  client.on("toolCall", (e) => contentEvents.push(e));

  // setupComplete should be silently consumed — not emitted as content
  client.injectServerMessage({ setupComplete: {} });

  assert("No spurious events from setupComplete", contentEvents.length, 0);
}

// ═════════════════════════════════════════════════════════════════
// CONFIG DEFAULTS
// ═════════════════════════════════════════════════════════════════

console.log("── Config defaults ────────────────────────────────────");

{
  const client = new TestableClient();
  // Check that deprecated model is NOT used
  const config = (client as any).config;
  assert(
    "Default model is NOT deprecated gemini-2.0-flash-live-001",
    config.model !== "gemini-2.0-flash-live-001",
    true
  );
  assert(
    "Default model is native audio preview",
    config.model,
    "gemini-2.5-flash-native-audio-preview-12-2025"
  );
  assert("Default voice is Puck", config.voiceName, "Puck");
  assert("Default manualVAD is false", config.manualVAD, false);
}

// ═════════════════════════════════════════════════════════════════
// EDGE CASES
// ═════════════════════════════════════════════════════════════════

console.log("── Edge: Empty serverContent ──────────────────────────");

{
  const client = new TestableClient();
  const events: Array<unknown> = [];
  client.on("content", (e) => events.push(e));
  client.on("transcription", (e) => events.push(e));

  // serverContent exists but has no meaningful fields
  client.injectServerMessage({ serverContent: {} });
  assert("No events from empty serverContent", events.length, 0);
}

console.log("── Edge: Unknown message type ────────────────────────");

{
  const client = new TestableClient();
  const errors: Error[] = [];
  client.on("error", (e) => errors.push(e));

  // Unknown message types should be silently ignored, not throw
  client.injectServerMessage({ unknownField: { data: "test" } });
  assert("No errors from unknown message type", errors.length, 0);
}

console.log("── Edge: Empty transcription text ignored ────────────");

{
  const client = new TestableClient();
  const events: Array<unknown> = [];
  client.on("transcription", (e) => events.push(e));

  client.injectServerMessage({
    serverContent: {
      inputTranscription: { text: "" },
    },
  });

  // Empty text should not emit a transcription event
  assert("Empty transcription ignored", events.length, 0);
}

// ═════════════════════════════════════════════════════════════════
// OUTBOUND MESSAGE FORMAT (send verification)
// ═════════════════════════════════════════════════════════════════
//
// Verifies the wire format of every client→server message type.
// TestableClient intercepts send() to capture the JSON payload.

console.log("── sendAudio format ──────────────────────────────────");

{
  const client = new TestableClient();
  const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  client.sendAudio(buf);

  const msg = client.outbound[0] as any;
  assert("sendAudio has realtimeInput", !!msg.realtimeInput, true);
  assert("sendAudio has audio field (not mediaChunks)",
    !!msg.realtimeInput.audio, true);
  assert("sendAudio has correct mimeType",
    msg.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert("sendAudio data is base64",
    msg.realtimeInput.audio.data, buf.toString("base64"));
}

console.log("── sendToolResponse format ───────────────────────────");

{
  const client = new TestableClient();
  // Object result — should pass through unchanged
  client.sendToolResponse("call-1", "read_file", { content: "hello" });

  const msg = client.outbound[0] as any;
  assert("sendToolResponse has toolResponse", !!msg.toolResponse, true);
  assert("sendToolResponse has functionResponses array",
    Array.isArray(msg.toolResponse.functionResponses), true);

  const fr = msg.toolResponse.functionResponses[0];
  assert("functionResponse id matches", fr.id, "call-1");
  assert("functionResponse name matches", fr.name, "read_file");
  assert("functionResponse response is the object",
    JSON.stringify(fr.response), JSON.stringify({ content: "hello" }));
}

console.log("── sendToolResponse wraps primitives ─────────────────");

{
  const client = new TestableClient();
  // Primitive result — must be wrapped in {result: ...} for protobuf Struct
  client.sendToolResponse("call-2", "count", 42);

  const msg = client.outbound[0] as any;
  const fr = msg.toolResponse.functionResponses[0];
  assert("Primitive wrapped in object",
    JSON.stringify(fr.response), JSON.stringify({ result: 42 }));
}

{
  const client = new TestableClient();
  // String result — also a primitive
  client.sendToolResponse("call-3", "greet", "hello");

  const msg = client.outbound[0] as any;
  const fr = msg.toolResponse.functionResponses[0];
  assert("String wrapped in object",
    JSON.stringify(fr.response), JSON.stringify({ result: "hello" }));
}

{
  const client = new TestableClient();
  // null result — primitive
  client.sendToolResponse("call-4", "noop", null);

  const msg = client.outbound[0] as any;
  const fr = msg.toolResponse.functionResponses[0];
  assert("Null wrapped in object",
    JSON.stringify(fr.response), JSON.stringify({ result: null }));
}

console.log("── sendActivityStart / sendActivityEnd format ────────");

{
  const client = new TestableClient();
  client.sendActivityStart();

  const msg = client.outbound[0] as any;
  assert("activityStart has realtimeInput", !!msg.realtimeInput, true);
  assert("activityStart has activityStart field",
    JSON.stringify(msg.realtimeInput.activityStart), "{}");
}

{
  const client = new TestableClient();
  client.sendActivityEnd();

  const msg = client.outbound[0] as any;
  assert("activityEnd has realtimeInput", !!msg.realtimeInput, true);
  assert("activityEnd has activityEnd field",
    JSON.stringify(msg.realtimeInput.activityEnd), "{}");
}

console.log("── sendInterrupt / sendEndOfTurn format ──────────────");

{
  const client = new TestableClient();
  client.sendInterrupt();

  const msg = client.outbound[0] as any;
  assert("sendInterrupt has clientContent", !!msg.clientContent, true);
  assert("sendInterrupt turnComplete is true",
    msg.clientContent.turnComplete, true);
  // Verify NO turns array — empty turns would inject empty user message
  assert("sendInterrupt has no turns array",
    msg.clientContent.turns, undefined);
}

{
  const client = new TestableClient();
  client.sendEndOfTurn();

  const msg = client.outbound[0] as any;
  assert("sendEndOfTurn has clientContent", !!msg.clientContent, true);
  assert("sendEndOfTurn same format as interrupt",
    msg.clientContent.turnComplete, true);
}

console.log("── sendToolResponse one response per message ─────────");

{
  const client = new TestableClient();
  client.sendToolResponse("a", "tool1", { x: 1 });
  client.sendToolResponse("b", "tool2", { y: 2 });

  assert("Two separate messages sent", client.outbound.length, 2);
  const fr1 = (client.outbound[0] as any).toolResponse.functionResponses;
  const fr2 = (client.outbound[1] as any).toolResponse.functionResponses;
  assert("First message has 1 response", fr1.length, 1);
  assert("Second message has 1 response", fr2.length, 1);
  assert("First response id", fr1[0].id, "a");
  assert("Second response id", fr2[0].id, "b");
}

// ── Results ────────────────────────────────────────────────────

console.log(
  `\n════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n════════════════════════════════════════════════════`
);
if (failed > 0) process.exit(1);
