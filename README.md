# Voice Mode for Gemini CLI — Streaming Orchestration Prototype

Proof-of-concept for [GSoC 2026 Project #11](https://github.com/google-gemini/gemini-cli/discussions/20145) — Hands-Free Multimodal Voice Mode.

## Problem

Gemini CLI currently uses the standard Gemini API via `GeminiChat.sendMessageStream()` — a turn-based request-response model. Voice interaction requires replacing this with the Live API's bidirectional WebSocket (`BidiGenerateContent`), which introduces three concurrent streams that must be orchestrated without race conditions:

- **Voice input** (continuous via `realtimeInput.audio`) — streams even during model output for barge-in detection
- **Model output** (streaming via `serverContent.modelTurn`) — audio + text, interruptible at any point
- **Tool execution** (async via `toolCall` / `toolResponse`) — must be cancellable mid-flight when the user changes intent

The hard problem isn't audio I/O — it's orchestrating these streams while maintaining transcript consistency, tool cancellation, and clean state transitions. This prototype proves that orchestration layer.

## How This Integrates into gemini-cli

The prototype is designed to slot into gemini-cli's existing architecture with minimal disruption. See [`gemini-cli-integration.ts`](src/gemini-cli-integration.ts) for the full integration layer with type-level mappings to gemini-cli's actual interfaces.

### Architecture mapping

```
Text mode (existing):     GeminiClient → GeminiChat → sendMessageStream
Voice mode (proposed):    GeminiClient → VoiceModeService → GeminiLiveClient (WebSocket)
```

### What changes, what doesn't

| gemini-cli component | Changes needed |
|---|---|
| `ToolRegistry` (tool-registry.ts) | **None.** VoiceModeService consumes `getToolSchemas()` as-is. Same `FunctionDeclaration` format works for both APIs. |
| `BaseDeclarativeTool` / `BaseToolInvocation` | **None.** The `createInvocation(params) → execute()` pattern works identically. `shouldConfirmExecute(signal)` already takes `AbortSignal`. |
| `CoreToolScheduler` | **Replaced** by `LiveToolExecutor` for voice sessions. Same validate → confirm → execute pipeline, but confirmation is voice-based (audio prompt + VAD) instead of diff-based. |
| `GeminiClient` (client.ts) | **Extended** with `createVoiceSession()` that returns a `VoiceModeService` instead of a `GeminiChat`. |
| `useGeminiStream` hook | **Augmented** with `useVoiceMode` hook that subscribes to `VoiceModeEvent` instead of stream chunks. |
| `Config` (config.ts) | **Extended** with voice settings: PTT toggle, voice name, VAD threshold. |

### Where files go in the monorepo

```
packages/core/src/voice/
├── voiceModeService.ts      ← Top-level orchestrator (replaces GeminiChat for voice)
├── liveClient.ts            ← WebSocket to Live API (BidiGenerateContent)
├── stateMachine.ts          ← 4-state FSM for concurrent stream coordination
├── transcriptManager.ts     ← Two-tier transcript (partial/committed)
├── interruptHandler.ts      ← Barge-in coordination across playback/tools/state
├── liveToolExecutor.ts      ← Bridges ToolRegistry to Live API tool calls
└── audioIO.ts               ← Mic capture + speaker output (PortAudio N-API)

packages/cli/src/ui/
├── components/VoiceMode.tsx  ← Ink component (waveform, transcript, tool indicators)
└── hooks/useVoiceMode.ts    ← React hook wrapping VoiceModeService
```

## State Machine

```
┌───────────┐  SPEECH_END   ┌──────────┐  MODEL_STREAM   ┌──────────┐
│ LISTENING  │──────────────▶│ THINKING │───────────────▶│ SPEAKING │
└───────────┘               └──────────┘                └──────────┘
      ▲                          │                           │
      │         TOOL_CALL_START  │                           │
      │                          ▼                           │
      │                    ┌───────────┐                     │
      │◀───────────────────│ TOOL_EXEC │◀────────────────────│
      │     INTERRUPT      └─────┬─────┘    TOOL_CALL_START  │
      │                          │ ▲                         │
      │                          └─┘ TOOL_CALL_START         │
      │                       (parallel tools)               │
      └──────────────────────────────────────────────────────┘
                          INTERRUPT (from any state)
```

Key design properties:

- `resolve()` is a **pure function** — deterministic `(state, event) → nextState`. Trivially unit-testable.
- **INTERRUPT is valid from any non-LISTENING state** — barge-in always works, no edge cases.
- **TOOL_CALL_START from TOOL_EXEC is a valid self-transition** — the Live API sends multiple `FunctionCall`s in one message. `TOOL_CALL_END` only fires when the last parallel tool completes.
- Invalid transitions return `null` (silently ignored) — real-time systems must never throw on stale events from concurrent streams.

## Demo

```bash
npm install
npm run demo      # No API key needed — simulated demo
```

Three scenarios demonstrating the critical orchestration challenges:

1. **Normal flow** — LISTENING → THINKING → TOOL_EXEC → SPEAKING → LISTENING
2. **Barge-in** — Model speaking → user interrupts → playback stops, generation cancels, partial response committed with ✂ marker
3. **Mid-tool interrupt** — Tool executing → user changes intent → AbortController cancels in-flight tool (~600ms), new intent captured

### With the Live API

```bash
export GEMINI_API_KEY=<your-key>
npm run dev            # Auto-VAD mode
npm run dev:ptt        # Push-to-talk mode
```

Audio hardware required. Install PortAudio: `brew install portaudio` (macOS) / `apt install portaudio19-dev` (Linux).

## Tests

```bash
npm test               # All 219 tests across 5 modules
npm run test:sm        # State machine (41 tests)
npm run test:tm        # Transcript manager (38 tests)
npm run test:ih        # Interrupt handler (27 tests)
npm run test:to        # Tool orchestrator (34 tests)
npm run test:lc        # Live API protocol (79 tests)
npm run typecheck      # TypeScript strict mode
```

| Module | Tests | What's verified |
|---|---|---|
| `stateMachine` | 41 | Pure state transitions, interrupt from every state, invalid transition handling, auto-VAD flow, parallel tool calls, reset on reconnect |
| `transcriptManager` | 38 | Partial/committed model, flush-before-tool, rollback-on-interrupt, multi-turn consistency |
| `interruptHandler` | 27 | Execution order, operation cancellation, energy thresholds, LISTENING no-op |
| `toolOrchestrator` | 34 | AbortController gating, cancellation mid-flight, unknown tool handling, cleanup, selective cancelByIds with parallel tools |
| `liveClient` | 79 | Protocol message parsing, transcription ordering, tool call serialization, Duration.nanos, outbound message format verification (sendAudio, sendToolResponse, sendActivity*, sendInterrupt), bundled turnComplete+parts |

## Protocol Decisions

Every protocol choice is grounded in the [Live API WebSocket reference](https://ai.google.dev/api/live):

| Decision | Rationale |
|---|---|
| Raw WebSocket, not SDK | Protocol transparency for interrupt timing. The `@google/genai` SDK abstracts away bidirectional stream details. |
| `realtimeInput.audio` (not `mediaChunks`) | `mediaChunks` is deprecated per API spec. |
| `activityStart`/`activityEnd` for PTT | API spec: "This can only be sent if automatic activity detection is disabled." |
| Audio forwarded in all states | API spec: `realtimeInput` "can be sent continuously without interruption to model generation." Server VAD needs this for barge-in. |
| `inputAudioTranscription` / `outputAudioTranscription` | Server-side transcription avoids client-side ASR dependency. |
| `gemini-2.5-flash-native-audio-preview-12-2025` | `gemini-2.0-flash-live-001` shut down December 9, 2025. |
| Tool response as native object (not stringified) | `FunctionResponse.response` is `google.protobuf.Struct` — must be a plain JSON object. |
| Transcriptions processed before turn signals | `serverContent` fields are independent, not a union. Early return on `turnComplete` would skip transcriptions in the same message. |
| Model parts processed before turn signals | `modelTurn.parts` and `turnComplete` are separate fields the API can bundle in one frame. Parts are emitted first so the final content chunk isn't dropped by `turnComplete`'s early return. |
| `sendInterrupt()` delegates to `sendEndOfTurn()` | Both send `clientContent.turnComplete: true`. The API uses the same wire message for both. |
| Auto-reconnect with exponential backoff + state reset | Live sessions disconnect after ~15 min of inactivity or on GoAway. On reconnect: cancel in-flight tools, reset FSM to LISTENING, commit buffered text as interrupted. |
| Parallel tool calls tracked with active count | Live API sends multiple `FunctionCall`s in one message. `TOOL_CALL_END` state transition delayed until last tool completes. Individual `toolResponse` messages sent immediately per completion. |
| Session resumption (future) | API supports `BidiGenerateContentSetup.sessionResumption` for context-preserving reconnects. Currently we start a fresh session on reconnect — adding resumption handles is a GSoC implementation task. |
| Non-blocking tool execution | Tools must not block the event loop — `execFile` (async) not `execFileSync`. Child processes wired to `signal.abort` → `child.kill()` for immediate cleanup on barge-in. `LiveToolExecutor` uses `Promise.race(execute(), abortSignal)` since `ToolInvocation.execute()` takes no signal parameter. |
| Text content resets transcription buffer | In text+audio mode, the API sends both text parts (authoritative) and output transcription (fallback). Ordering is not guaranteed. If transcription arrives before the first text content event, the buffer would double-count. On the first text event, the buffer is cleared so only the authoritative source contributes to the committed transcript. |

## Author

Krish Garg — IIT Roorkee
[Discussion #20145](https://github.com/google-gemini/gemini-cli/discussions/20145)
