# Changelog

All notable changes to `@shichen335/openclaw-logfire` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-09

### Changed

- Released the plugin as `@shichen335/openclaw-logfire` for npm distribution under the forked repository
- Updated package metadata, docs, and published runtime version strings to `1.0.0`
- Kept the plugin id as `openclaw-logfire` so existing OpenClaw config keys continue to work

## [0.3.0] - 2026-02-16

### Added

- `llm_input` and `llm_output` hook handlers for per-LLM-call observability
- Individual `gen_ai.chat` child spans for each LLM invocation, correlated by `runId`
- Token usage metrics now populated with real data from `llm_output` hook (`recordTokenUsage()` was previously stubbed but never called)
- Model name tracking (`gen_ai.request.model`, `gen_ai.response.model`) on LLM and agent spans
- Cache token tracking (`openclaw.usage.cache_read_tokens`, `openclaw.usage.cache_write_tokens`) on LLM spans
- Cumulative token counts set on root `invoke_agent` span at session end
- Inference detail events (`gen_ai.client.inference.operation.details`) now emitted when `captureInferenceEvents` is enabled

### Changed

- **OpenTelemetry SDK upgraded from 1.x to 2.x** — stable SDK 1.30→2.5, experimental 0.57→0.212. Only breaking change: `Resource` class constructor replaced with `resourceFromAttributes()`. Dependency ranges updated; consumers using OTEL 2.x will no longer see peer dep warnings.
- Token usage metrics include actual model names instead of empty strings
- Operation duration metrics include model name and provider from LLM hooks
- Provider name on agent span is updated from `llm_input` when config `providerName` is unset
- Zero-value token counts (e.g. 0 output tokens) are now correctly accumulated — fixed truthy checks that silently dropped zeros
- LLM span closure wrapped in `try/finally` to prevent span leaks on exceptions
- Prompt content capture now applies `prepareForCapture()` redaction and truncation (consistent with tool args)
- `isRecord` runtime guard added to `llm_input`/`llm_output` hook registrations (consistent with all other hooks)
- Orphaned span cleanup uses LIFO order (children before parent) for valid trace trees

### Testing

- Hook handler unit tests added — 113 tests across 11 files, coverage boosted from 28% to 67%

### Known Limitations

- `after_tool_call` hook not yet implemented — OpenClaw SDK passes `sessionKey: undefined` at all call sites, making span store lookup impossible. Per-tool error status is not available on tool spans. Tool errors are still captured at the agent level via the `agent_end` hook. Pending upstream fix.

## [0.2.0] - 2026-02-16

### Fixed

- **Breaking:** Align all hook handlers with the OpenClaw plugin SDK `(event, ctx)` two-argument contract. Previous version only captured the first argument and expected context data nested inside the event, which caused `TypeError: Cannot read properties of undefined` on every hook invocation.
- Correct event property names: `event.toolName` (was `event.tool?.name`), `event.params` (was `event.tool?.args`), `event.message` (was `event.result`)

### Removed

- Token usage recording in `agent_end` — token data is not available in the `agent_end` event payload (restored in 0.3.0 via `llm_output` hook)
- W3C trace context extraction from webhook headers in `message_received` — raw HTTP headers are not exposed in the `message_received` event metadata
- Per-tool error recording in `tool_result_persist` — error details are not available in that hook's event payload

## [0.1.2] - 2026-02-16

### Fixed

- Read plugin config from `api.pluginConfig` instead of `api.config` — OpenClaw passes the full application config as `api.config` and the plugin-specific config as `api.pluginConfig`. Reading from `api.config` caused all settings (environment, providerName, etc.) to silently fall through to defaults.

## [0.1.1] - 2026-02-16

### Fixed

- Removed JSON Schema `$schema` declaration (draft 2020-12) from `openclaw.plugin.json` — OpenClaw's bundled Ajv only supports draft-07 and crashes on any CLI command when an incompatible `$schema` is present
- Changed plugin manifest `id` from `"logfire"` to `"openclaw-logfire"` — OpenClaw resolves plugin config by manifest `id`, and the mismatch caused config entries to silently not pass through to the plugin

### Changed

- **Breaking:** Config entry key must now be `"openclaw-logfire"` (was `"logfire"`) to match the corrected manifest `id`

### Added

- `SKILL.md` for ClawHub registry listing

## [0.1.0] - 2026-02-15

### Added

- Initial release
- Full agent lifecycle tracing with OTEL GenAI semantic conventions
- `invoke_agent` root spans with agent name, session key, workspace, and channel attribution
- `execute_tool` child spans with tool arguments, duration, and result size
- Error tracing with OTEL exception events (type, message, stack trace)
- Token usage metrics (`gen_ai.client.token.usage` histogram)
- Operation duration metrics (`gen_ai.client.operation.duration` histogram)
- Pydantic Logfire OTLP HTTP export (US and EU regions)
- Clickable Logfire trace URLs in agent logs
- Secret redaction for API keys, platform tokens, JWTs, and credentials
- W3C traceparent injection into HTTP commands for distributed tracing
- W3C trace context extraction from inbound webhook headers
- Configurable trace depth (tool input/output capture, message content, inference events)
- Batch and simple span processor modes
- Zero-config quickstart (just set `LOGFIRE_TOKEN`)

[1.0.0]: https://github.com/chenbaiyujason/openclaw-logfire/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/Ultrathink-Solutions/openclaw-logfire/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ultrathink-Solutions/openclaw-logfire/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Ultrathink-Solutions/openclaw-logfire/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Ultrathink-Solutions/openclaw-logfire/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ultrathink-Solutions/openclaw-logfire/releases/tag/v0.1.0
