# Contributing to @promptlayer/openclaw-promptlayer

Thanks for your interest in contributing. This guide covers setup, development, and review expectations for the PromptLayer OpenClaw integration.

## Prerequisites

- Node.js `>= 20`
- npm
- Git

## Setup

```bash
git clone https://github.com/MagnivOrg/openclaw-promptlayer
cd openclaw-promptlayer
npm install
```

## Project Structure

```text
src/
  index.ts                  Plugin entry point: hook wiring and lifecycle
  config.ts                 Typed configuration with PromptLayer env fallbacks
  otel.ts                   OTEL trace exporter setup for PromptLayer
  gen-ai-span-attributes.ts GenAI usage attributes
  util.ts                   Message normalization and JSON handling
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
git commit -m "feat: describe the change"
git push -u origin feat/my-change
```

Use conventional commit prefixes when practical:

| Prefix | Use for |
|---|---|
| `feat:` | New functionality |
| `fix:` | Bug fixes |
| `docs:` | Documentation-only changes |
| `refactor:` | Behavior-preserving code restructuring |
| `chore:` | Build, CI, or metadata changes |

## Writing Code

### OTEL GenAI Semantics

This plugin follows OpenTelemetry GenAI semantic conventions where they fit OpenClaw's hook data.

- Use `gen_ai.*` for standard GenAI attributes.
- Use `openclaw.*` for OpenClaw-specific metadata.
- Use `session.id` and `gen_ai.conversation.id` for the OpenClaw session key.
- Record message payloads using modern GenAI message attributes.

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

### Payload Handling

Captured messages and tool payloads can contain sensitive data.

- Use `prepareForCapture()` for serialized payload attributes.
- Do not truncate serialized JSON attributes; downstream ingestion expects valid JSON.
- Keep API keys in environment variables and do not commit secrets into config.

## Documentation

Keep README, changelog, and skill guidance aligned with the current PromptLayer implementation. Do not document removed or unimplemented runtime behavior as current functionality.

## Origins

This project began as a repurposed fork of the OpenClaw Logfire plugin. The current PromptLayer integration has diverged substantially; contributor docs should describe only the current PromptLayer code paths.

## Questions

Open an issue on the [GitHub repo](https://github.com/MagnivOrg/openclaw-promptlayer/issues).
