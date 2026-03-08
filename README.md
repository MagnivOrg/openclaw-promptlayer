# @shichen335/openclaw-logfire

[![npm version](https://img.shields.io/npm/v/@shichen335/openclaw-logfire)](https://www.npmjs.com/package/@shichen335/openclaw-logfire)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`openclaw-logfire` sends OpenClaw agent activity to [Pydantic Logfire](https://pydantic.dev/logfire) as OTLP traces and metrics.

It captures the real execution shape of an OpenClaw run:

- one root `invoke_agent` span per agent invocation
- staged `chat <model>` spans reconstructed from `llm_input` and `llm_output`
- one `execute_tool <tool>` span per tool call
- token usage metrics and cumulative session usage
- optional `traceparent` injection for HTTP commands such as `curl`, `wget`, `http`, and `httpie`

The plugin is designed around the latest OpenClaw hook flow and OTEL GenAI semantic conventions, while staying practical about privacy controls and debugging.

## Requirements

- OpenClaw `>= 2026.2.1`
- Node.js `>= 20`
- A Logfire `write token`
- Network access to Logfire OTLP endpoints:
  - `https://logfire-us.pydantic.dev`
  - `https://logfire-eu.pydantic.dev`

## Install

For most users, install it as an OpenClaw plugin:

```bash
openclaw plugins install @shichen335/openclaw-logfire
```

Then enable it in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

The plugin id must be `openclaw-logfire`.

## Get A Logfire Write Token

This plugin uses a Logfire `write token`. The environment variable name is `LOGFIRE_TOKEN`.

1. Open [Logfire Login](https://logfire.pydantic.dev/login) and sign up or sign in.
2. If this is your first time in Logfire, finish the onboarding flow.
3. If you want a dedicated project for OpenClaw, open `Organization > Projects` and create one.
4. Open the target project.
5. Go to `Settings > Write tokens`.
6. Click `New write token`.
7. Copy the token immediately. Logfire does not show the full token again later.
8. Export it in your shell:

```bash
export LOGFIRE_TOKEN="<your-write-token>"
```

Useful official links:

- [Logfire Getting Started](https://docs.pydantic.dev/logfire/)
- [Create Write Tokens](https://docs.pydantic.dev/logfire/how-to-guides/create-write-tokens/)

## Quick Start

Minimal configuration:

```json
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Then restart OpenClaw. The plugin reads `LOGFIRE_TOKEN` at runtime and starts exporting spans.

If `LOGFIRE_TOKEN` is missing, the plugin disables itself and logs an error instead of starting half-configured.

## Recommended Configuration

This example is based on a real OpenClaw setup and works well when you want rich debugging and full message capture. Replace placeholders before use.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {
          // Prefer LOGFIRE_TOKEN via environment variable.
          // You can set "token" here, but env var is safer.
          "projectUrl": "https://logfire.pydantic.dev/<org>/<project>",

          // Map non-standard provider ids to OTel-friendly names.
          "providerNameMap": {
            "customprovider": "openai"
          },

          // Full payload capture for debugging.
          "captureMessageContent": true,
          "captureHistoryMessages": true,
          "historyMessagesMaxLength": 100000,
          "toolInputMaxLength": 100000,
          "toolOutputMaxLength": 16384,

          // Privacy and persistence switches.
          "redactSecrets": false,
          "saveHookLogs": false
        }
      }
    }
  }
}
```

Notes:

- `projectUrl` enables clickable trace links when `enableTraceLinks` is on.
- `providerNameMap` is useful when your OpenClaw provider id is not a standard OTel GenAI provider name.
- `captureMessageContent: true` also increases what can be captured from tool inputs and outputs. Review privacy expectations before enabling it.
- `captureToolDefinitions` is accepted by the schema, but it is currently reserved and does not change runtime behavior in `1.0.0`.

## What The Plugin Captures

### Span tree

A typical trace looks like this:

```text
invoke_agent main
  |- chat gpt-5.4
  |- running 2 tools
  |   |- execute_tool Read
  |   `- execute_tool Shell
  `- chat gpt-5.4
```

### Root span

The root `invoke_agent <agent>` span stores:

- conversation id and channel metadata when available
- cumulative input, output, cache read, and cache write token counts
- tool count and overall duration
- reconstructed `pydantic_ai.all_messages`
- `final_result` when a final assistant result can be extracted

### Chat spans

The plugin does not keep a single long-lived chat span open through the whole turn.
Instead, it reconstructs one or more `chat <model>` spans from the final conversation shape emitted by `llm_output`.

That means:

- tool-call boundaries appear as separate chat phases
- final assistant content is more accurate when OpenClaw emits `llm_output` after `lastAssistant` is fully assembled
- if `lastAssistant` is incomplete, the plugin falls back to `assistantTexts`

### Tool spans

Each tool call becomes `execute_tool <tool>`.

Depending on configuration, the span may include:

- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`
- output size and timing metadata

Tool calls from the same `runId` also produce a synthetic group span such as `running 1 tool` or `running 3 tools`.

### Metrics

When `enableMetrics` is `true`, the plugin exports:

- `gen_ai.client.token.usage`
- `gen_ai.client.operation.duration`

## Configuration Reference

All config lives under `plugins.entries.openclaw-logfire.config`.

### Environment variable fallbacks

| Variable | Used for | Notes |
|---|---|---|
| `LOGFIRE_TOKEN` | `token` | Required at runtime unless `token` is set directly |
| `LOGFIRE_PROJECT_URL` | `projectUrl` | Optional |
| `LOGFIRE_ENVIRONMENT` | `environment` | Defaults to `development` |
| `LOGFIRE_PROVIDER_NAME` | `providerName` | Optional |

### Active runtime options

These options are parsed by the config resolver and currently affect runtime behavior.

| Key | Type | Default | Description |
|---|---|---:|---|
| `token` | `string` | `""` | Logfire write token. Prefer `LOGFIRE_TOKEN` instead of committing it into config. |
| `projectUrl` | `string` | `""` | Project URL used to build clickable trace links. |
| `region` | `"us" \| "eu"` | `"us"` | Selects the OTLP base endpoint. |
| `environment` | `string` | `"development"` | Deployment environment resource attribute. |
| `serviceName` | `string` | `"openclaw-agent"` | OTEL `service.name`. |
| `providerName` | `string` | `""` | Default provider name when OpenClaw metadata does not provide one. |
| `providerNameMap` | `Record<string, string>` | `{}` | Maps OpenClaw provider ids to OTEL provider names. |
| `captureToolInput` | `boolean` | `true` | Captures tool arguments. |
| `captureToolOutput` | `boolean` | `false` | Captures tool results. |
| `toolInputMaxLength` | `integer` | `2048` | Truncation limit for tool input capture. |
| `toolOutputMaxLength` | `integer` | `512` | Truncation limit for tool output capture and chat output capture. |
| `captureMessageContent` | `boolean` | `false` | Captures chat input, chat output, and system instructions. Privacy-sensitive. |
| `captureHistoryMessages` | `boolean` | `false` | Helps reconstruct multi-turn conversation history on the root span. |
| `historyMessagesMaxLength` | `integer` | `16384` | Truncation limit for serialized history messages. |
| `redactSecrets` | `boolean` | `true` | Redacts common API keys, bearer tokens, JWTs, passwords, and similar secrets before capture. |
| `distributedTracing.enabled` | `boolean` | `false` | Enables command-level trace propagation. |
| `distributedTracing.injectIntoCommands` | `boolean` | `true` | Injects `traceparent` into matching HTTP commands. |
| `distributedTracing.urlPatterns` | `string[]` | `["*"]` | URL glob patterns that are allowed for injection. |
| `enableMetrics` | `boolean` | `true` | Enables OTLP metric export. |
| `metricsIntervalMs` | `integer` | `60000` | Metric export interval in milliseconds. |
| `enableTraceLinks` | `boolean` | `true` | Logs clickable project trace links when `projectUrl` is configured. |
| `saveHookLogs` | `boolean` | `false` | Persists raw hook payloads to `~/.openclaw/logs/` for debugging. |
| `resourceAttributes` | `Record<string, string>` | `{}` | Additional OTEL resource attributes. |
| `spanProcessorType` | `"batch" \| "simple"` | `"batch"` | Use `simple` when debugging exporter behavior. |
| `batchConfig.maxQueueSize` | `integer` | `2048` | Batch span processor queue size. |
| `batchConfig.maxExportBatchSize` | `integer` | `512` | Maximum spans per export batch. |
| `batchConfig.scheduledDelayMs` | `integer` | `5000` | Delay between batch exports. |

### Accepted but currently reserved options

These keys are accepted by the schema and config resolver, but they are not fully wired into runtime behavior in `1.0.0`.

| Key | Current status |
|---|---|
| `captureStackTraces` | Reserved. Current runtime does not branch on this flag. |
| `captureToolDefinitions` | Reserved. Accepted by schema, but not currently attached to spans. |
| `distributedTracing.extractFromWebhooks` | Reserved. Current implementation focuses on outbound command injection. |
| `logLevel` | Reserved. Accepted by config, but plugin logging does not currently change behavior from it. |
| `useGenAiCompatibilityScope` | Legacy compatibility field kept in config code, not surfaced in plugin schema. |

## Privacy And Safety Notes

- `captureMessageContent: true` is the highest-impact privacy switch.
- `captureToolOutput: true` can capture large or sensitive tool results.
- `redactSecrets: true` helps, but it is best-effort rather than a formal DLP guarantee.
- `saveHookLogs: true` writes raw payloads to local disk. Turn it off after debugging.
- Prefer `LOGFIRE_TOKEN` in the shell environment instead of committing tokens into `openclaw.json`.

## Distributed Tracing

When enabled, the plugin injects W3C `traceparent` into matching command parameters before the tool runs.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {
          "distributedTracing": {
            "enabled": true,
            "injectIntoCommands": true,
            "urlPatterns": [
              "https://api.example.com/*",
              "http://localhost:8000/*"
            ]
          }
        }
      }
    }
  }
}
```

Current scope:

- works for outbound command injection only
- targets HTTP-like commands such as `curl`, `wget`, `http`, and `httpie`
- respects `distributedTracing.urlPatterns`

## Troubleshooting

### No traces appear

Check these first:

1. `LOGFIRE_TOKEN` is set in the environment seen by OpenClaw.
2. The plugin entry key is exactly `openclaw-logfire`.
3. OpenClaw is at least `2026.2.1`.
4. OpenClaw was restarted after config changes.
5. Your machine can reach the selected Logfire region endpoint.

### Agent spans exist, but chat spans are incomplete

Make sure OpenClaw emits `llm_output` after the final `lastAssistant` object is fully assembled. The plugin reconstructs chat phases from the completed assistant payload.

### Tool spans do not show failures clearly

Current OpenClaw hook payloads do not always expose tool-level error details at `tool_result_persist`, so failures may be reflected on the root agent span rather than the individual tool span.

### I need raw hook payloads

Temporarily set:

```json
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {
          "saveHookLogs": true
        }
      }
    }
  }
}
```

This writes hook payloads to `~/.openclaw/logs/`.

## Local Development

```bash
git clone https://github.com/chenbaiyujason/openclaw-logfire
cd openclaw-logfire
npm install
npm run build
npm run typecheck
npm test
```

To load the local checkout in OpenClaw, either symlink it into your extensions directory or add the repo path to `plugins.load.paths`.

```bash
ln -s "$(pwd)" ~/.openclaw/extensions/openclaw-logfire
```

Or:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-logfire"
      ]
    }
  }
}
```

Then export `LOGFIRE_TOKEN`, restart OpenClaw, and verify with:

```bash
openclaw plugins list
```

## License

MIT
