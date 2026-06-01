# Contributing to @promptlayer/openclaw-promptlayer

Thanks for your interest in contributing. This guide covers setup, development, testing, and review expectations for the PromptLayer OpenClaw integration.

## Prerequisites

- Node.js `>= 20`
- npm
- Git
- OpenClaw `>= 2026.2.1` for local integration testing

## Setup

```bash
git clone https://github.com/MagnivOrg/openclaw-promptlayer
cd openclaw-promptlayer
npm install
```

Verify the checkout:

```bash
npm run typecheck
npm run lint
npm test
```

## Project Structure

```text
src/
  index.ts                  Plugin entry point: hook wiring and lifecycle
  config.ts                 Typed configuration with PromptLayer env fallbacks
  otel.ts                   OTEL trace exporter setup for PromptLayer
  gen-ai-span-attributes.ts GenAI prompt/completion and usage attributes
  util.ts                   Message normalization, JSON handling, truncation, redaction
  hooks/
    before-agent-start.ts   Root invoke_agent span creation
    llm-input.ts            Pending chat span context capture
    llm-output.ts           Chat span emission and token accumulation
    before-tool-call.ts     execute_tool span creation
    tool-result-persist.ts  Tool span closure and result metadata
    agent-end.ts            Root span finalization and deferred final-chat handling
    chat-span.ts            Shared chat span construction
  context/
    span-store.ts           Session-to-span state, LIFO tool stack, pending LLM spans
```

## Development Workflow

Create a branch, make focused changes, and verify before opening a PR:

```bash
git checkout -b feat/my-change
npm run typecheck
npm run lint
npm test
git commit -m "feat: describe the change"
git push -u origin feat/my-change
```

Use conventional commit prefixes when practical:

| Prefix | Use for |
|---|---|
| `feat:` | New functionality |
| `fix:` | Bug fixes |
| `docs:` | Documentation-only changes |
| `test:` | Test additions or fixes |
| `refactor:` | Behavior-preserving code restructuring |
| `chore:` | Build, CI, or metadata changes |

## Writing Code

### OTEL GenAI Semantics

This plugin follows OpenTelemetry GenAI semantic conventions where they fit OpenClaw's hook data.

- Use `gen_ai.*` for standard GenAI attributes.
- Use `openclaw.*` for OpenClaw-specific metadata.
- Use `session.id` and `gen_ai.conversation.id` for the OpenClaw session key.
- Keep message payload capture behind config flags.

Common attributes:

| Attribute | Meaning |
|---|---|
| `gen_ai.operation.name` | `invoke_agent`, `chat`, or `execute_tool` |
| `gen_ai.agent.name` | OpenClaw agent id/name |
| `gen_ai.provider.name` | Resolved GenAI provider |
| `gen_ai.request.model` | Requested model on chat spans |
| `gen_ai.response.model` | Response model on chat spans |
| `gen_ai.tool.name` | Tool being called |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `error.type` | Error class/category |

### Span Lifecycle

Every opened span must be closed.

1. `before_agent_start` opens the root `invoke_agent` span.
2. `llm_input` stores pending chat context for a specific `runId`.
3. `llm_output` emits the `chat <model>` span and removes the pending LLM entry.
4. `before_tool_call` opens an `execute_tool <tool>` span.
5. `tool_result_persist` closes the latest tool span.
6. `agent_end` closes the root span, waiting briefly for pending `llm_output` work when needed.

Use `try/finally` around span closure paths so hook errors do not leak spans.

### Error Isolation

Plugin errors must never crash the OpenClaw host process. Hook registrations in `index.ts` wrap handlers in `try/catch`. Keep that pattern for any new hook:

```typescript
api.on('hook_name', (event, ctx) => {
  try {
    handleHook(event, ctx, config);
  } catch (err) {
    api.logger.warn(`PromptLayer hook_name error: ${err}`);
  }
});
```

### Privacy Controls

Captured messages and tool payloads can contain sensitive data.

- Check `captureMessageContent`, `captureHistoryMessages`, `captureToolInput`, and `captureToolOutput` before recording payloads.
- Use `prepareForCapture()` for serialized payloads so redaction and truncation are applied consistently.
- Keep `redactSecrets` enabled by default.

## Writing Tests

Tests live next to source as `*.test.ts`.

Test these areas:

- Config defaults, env var fallbacks, and explicit overrides
- Message normalization for OpenClaw/OpenAI/Anthropic-style payloads
- Span store behavior, including LIFO tool closure and cleanup
- Hook behavior for root, chat, and tool spans
- Redaction and truncation behavior
- Deferred agent finalization and final-answer chat reconstruction

Avoid testing OpenTelemetry SDK internals or exact OTLP wire format.

All test names, fixtures, and inline comments should be English-only.

## Local Testing With OpenClaw

To test against a real OpenClaw instance:

```bash
ln -s "$(pwd)" ~/.openclaw/extensions/openclaw-promptlayer
export PROMPTLAYER_API_KEY="<your-api-key>"
openclaw restart
openclaw plugins list
```

Or add the checkout path to `plugins.load.paths` in `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/openclaw-promptlayer"]
    }
  }
}
```

The plugin should show as `openclaw-promptlayer`.

## Documentation

Keep README, changelog, and skill guidance aligned with the current PromptLayer implementation. Do not document removed or unimplemented runtime behavior as current functionality.

## Origins

This project began as a repurposed fork of the OpenClaw Logfire plugin. The current PromptLayer integration has diverged substantially; contributor docs should describe only the current PromptLayer code paths.

## Questions

Open an issue on the [GitHub repo](https://github.com/MagnivOrg/openclaw-promptlayer/issues).
