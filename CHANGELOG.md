# Changelog

All notable changes to `@promptlayer/openclaw-promptlayer` will be documented in this file.


## [1.0.0] - 2026-06-01

### Added

- PromptLayer OTLP trace export for OpenClaw agent runs.
- `openclaw-promptlayer` plugin manifest id and `@promptlayer/openclaw-promptlayer` package naming.
- `PROMPTLAYER_API_KEY`, `PROMPTLAYER_ENVIRONMENT`, and `PROMPTLAYER_PROVIDER_NAME` environment fallbacks.
- `invoke_agent <agent>` root spans with OpenClaw session, workspace, channel, duration, tool count, and error metadata.
- `chat <model>` spans reconstructed from `llm_input` and `llm_output` hook events.
- `execute_tool <tool>` spans with tool call id, sequence, duration, output size, and optional argument/result capture.
- Optional GenAI message capture via `captureMessageContent` and `captureHistoryMessages`.
- Indexed GenAI prompt/completion attributes and `gen_ai.input.messages` / `gen_ai.output.messages` payloads for captured chat spans.
- Tool definition capture on chat spans when message content capture is enabled.
- Token usage attributes on chat spans when OpenClaw exposes usage data.
- Final-answer chat span reconstruction when agent completion arrives after tool turns.
- Secret redaction and truncation controls for captured messages and tool payloads.
- Batch and simple span processor modes for production export and exporter debugging.
- Export failure warnings in OpenClaw logs when PromptLayer trace export fails.

### Changed

- Reframed documentation around the current PromptLayer behavior.
- Updated documentation, examples, troubleshooting, and contributor guidance around PromptLayer-specific setup and config.
- Made comments and tests English-only.
