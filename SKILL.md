---
name: openclaw-logfire
description: Installs and configures the openclaw-logfire plugin for OpenClaw, including LOGFIRE_TOKEN setup, openclaw.json edits, provider mapping, privacy settings, and Logfire write token onboarding. Use when a user wants Logfire observability, traces, token metrics, or help connecting OpenClaw to Logfire.
version: 1.0.0
homepage: https://github.com/chenbaiyujason/openclaw-logfire
metadata:
  openclaw:
    pluginId: openclaw-logfire
    primaryEnv: LOGFIRE_TOKEN
    requires:
      env:
        - LOGFIRE_TOKEN
---

# OpenClaw Logfire

Use this skill when the user wants to install, configure, debug, or explain the `@shichen335/openclaw-logfire` plugin.

## Goal

Set up `openclaw-logfire` so OpenClaw exports agent traces and metrics to Pydantic Logfire.

## Preconditions

Confirm these before editing anything:

- OpenClaw version is `>= 2026.2.1`
- Node.js version is `>= 20`
- The plugin entry key will be `plugins.entries.openclaw-logfire`
- A Logfire `write token` is available, or the user wants guidance to create one

## Default Workflow

Follow this order:

1. Install the plugin:

```bash
openclaw plugins install @shichen335/openclaw-logfire
```

2. Prefer environment-based auth:

```bash
export LOGFIRE_TOKEN="<your-write-token>"
```

3. Add or update `openclaw.json`:

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

4. Restart OpenClaw.
5. Verify that Logfire receives spans.

## If The User Does Not Have A Token Yet

Guide them through the Logfire web UI:

1. Open [Logfire Login](https://logfire.pydantic.dev/login).
2. Sign up or sign in.
3. If needed, create a project in `Organization > Projects`.
4. Open the target project.
5. Go to `Settings > Write tokens`.
6. Create a new `write token`.
7. Tell the user to save it immediately.
8. Use that value as `LOGFIRE_TOKEN`.

Use the term `write token`, not `project token`.
Use the environment variable `LOGFIRE_TOKEN`, not `LOGFIRE_WRITE_TOKEN`.

## Recommended Config Templates

### Minimal

Use this when the user wants the safest starting point:

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

### Rich Debugging

Use this when the user wants deep payload visibility and accepts privacy trade-offs:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-logfire": {
        "enabled": true,
        "config": {
          // Use LOGFIRE_TOKEN in the environment unless the user explicitly
          // wants to keep the token in config.
          "projectUrl": "https://logfire.pydantic.dev/<org>/<project>",
          "providerNameMap": {
            "customprovider": "openai"
          },
          "captureMessageContent": true,
          "captureHistoryMessages": true,
          "historyMessagesMaxLength": 100000,
          "toolInputMaxLength": 100000,
          "toolOutputMaxLength": 16384,
          "redactSecrets": false,
          "saveHookLogs": false
        }
      }
    }
  }
}
```

## Supported Config Keys

These keys currently affect runtime behavior:

| Key | Default | Notes |
|---|---:|---|
| `token` | `""` | Prefer `LOGFIRE_TOKEN`. Without a token, the plugin disables itself. |
| `projectUrl` | `""` | Enables clickable trace links when `enableTraceLinks` is `true`. |
| `region` | `"us"` | Accepts `"us"` or `"eu"`. |
| `environment` | `"development"` | Falls back to `LOGFIRE_ENVIRONMENT`. |
| `serviceName` | `"openclaw-agent"` | OTEL `service.name`. |
| `providerName` | `""` | Falls back to `LOGFIRE_PROVIDER_NAME`. |
| `providerNameMap` | `{}` | Useful for ids such as `customprovider -> openai`. |
| `captureToolInput` | `true` | Captures tool arguments. |
| `captureToolOutput` | `false` | Captures tool results. |
| `toolInputMaxLength` | `2048` | Integer truncation limit. |
| `toolOutputMaxLength` | `512` | Integer truncation limit. |
| `captureMessageContent` | `false` | Captures chat content and system instructions. Privacy-sensitive. |
| `captureHistoryMessages` | `false` | Helps reconstruct conversation history on the root span. |
| `historyMessagesMaxLength` | `16384` | Integer truncation limit for serialized history. |
| `redactSecrets` | `true` | Best-effort secret redaction. |
| `distributedTracing.enabled` | `false` | Enables outbound command propagation. |
| `distributedTracing.injectIntoCommands` | `true` | Injects `traceparent` into matching commands. |
| `distributedTracing.urlPatterns` | `["*"]` | URL glob allowlist. |
| `enableMetrics` | `true` | Sends token and duration metrics. |
| `metricsIntervalMs` | `60000` | Metrics export interval. |
| `enableTraceLinks` | `true` | Logs clickable trace links when `projectUrl` exists. |
| `saveHookLogs` | `false` | Writes raw hook payloads to `~/.openclaw/logs/`. |
| `resourceAttributes` | `{}` | Additional OTEL resource attributes. |
| `spanProcessorType` | `"batch"` | Use `"simple"` for debugging. |
| `batchConfig.maxQueueSize` | `2048` | Batch exporter queue size. |
| `batchConfig.maxExportBatchSize` | `512` | Batch size limit. |
| `batchConfig.scheduledDelayMs` | `5000` | Batch delay. |

## Accepted But Not Fully Wired

These keys are accepted by the schema or resolver, but should not be described as fully effective:

| Key | Status |
|---|---|
| `captureStackTraces` | Reserved |
| `captureToolDefinitions` | Reserved |
| `distributedTracing.extractFromWebhooks` | Reserved |
| `logLevel` | Reserved |
| `useGenAiCompatibilityScope` | Legacy compatibility field |

## Behavior Notes The Agent Should Know

- The plugin reconstructs `chat <model>` spans at `llm_output`, not at `llm_input`.
- `llm_output` should run after OpenClaw has assembled the full `lastAssistant`, or Logfire may show incomplete output.
- `agent_end` may wait briefly for pending `llm_output` processing before finalizing the root span.
- `captureMessageContent: true` increases the amount of captured content significantly.
- `saveHookLogs: true` writes local files and should usually be temporary.

## Privacy Defaults

Prefer these defaults unless the user explicitly asks for richer capture:

- keep `captureMessageContent: false`
- keep `captureToolOutput: false`
- keep `redactSecrets: true`
- keep `saveHookLogs: false`
- keep the token in the environment, not in committed config

## Troubleshooting Checklist

If traces do not appear:

1. Check that `LOGFIRE_TOKEN` exists in the runtime environment.
2. Check that the plugin key is exactly `openclaw-logfire`.
3. Check that OpenClaw was restarted.
4. Check that OpenClaw is new enough to emit `llm_input`, `llm_output`, and `before_tool_call`.
5. Check network access to the selected Logfire region.

If chat spans are missing or incomplete:

1. Check whether `llm_output` is emitted with the final `lastAssistant`.
2. Check whether the run only produced tool calls without a completed assistant payload.

If the user wants to inspect hook payloads:

1. Temporarily enable `saveHookLogs: true`.
2. Reproduce the issue.
3. Turn `saveHookLogs` back off after debugging.

## Output Guidance

When helping a user:

- prefer a minimal config first
- explain privacy-sensitive options before enabling them
- never echo or commit a real token
- redact any shared secrets when quoting `openclaw.json`
- use `projectUrl` only for the Logfire web project URL, not an OTLP endpoint
