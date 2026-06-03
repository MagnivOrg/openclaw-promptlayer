---
name: openclaw-promptlayer
description: Installs, configures, and troubleshoots the PromptLayer observability plugin for OpenClaw, including PROMPTLAYER_API_KEY setup, openclaw.json edits, provider mapping, privacy settings, and trace export debugging.
version: 1.0.0
homepage: https://github.com/MagnivOrg/openclaw-promptlayer
metadata:
  openclaw:
    pluginId: openclaw-promptlayer
    primaryEnv: PROMPTLAYER_API_KEY
    requires:
      env:
        - PROMPTLAYER_API_KEY
---

# OpenClaw PromptLayer

Use this skill when the user wants to install, configure, debug, or explain the `@promptlayer/openclaw-promptlayer` plugin.

## Goal

Set up `openclaw-promptlayer` so OpenClaw exports agent traces to PromptLayer.

## Preconditions

Confirm these before editing anything:

- OpenClaw version is `>= 2026.2.1`
- Node.js version is `>= 20`
- The plugin entry key will be `plugins.entries.openclaw-promptlayer`
- A PromptLayer API key is available, or the user wants guidance to create one

## Default Workflow

Follow this order:

1. Install the plugin:

```bash
openclaw plugins install @promptlayer/openclaw-promptlayer
openclaw plugins enable openclaw-promptlayer
```

2. Prefer environment-based auth:

```bash
export PROMPTLAYER_API_KEY="<your-api-key>"
```

3. Add or update `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {}
      }
    }
  }
}
```

4. Restart OpenClaw:

```bash
openclaw gateway restart
```

5. Verify that PromptLayer receives traces.

## If The User Does Not Have An API Key Yet

Guide them to create or retrieve a PromptLayer API key from their PromptLayer account settings or workspace settings. Use the environment variable `PROMPTLAYER_API_KEY` unless they explicitly want to put the key in OpenClaw config as `apiKey`.

Install alone is not enough. The plugin intentionally disables itself unless the OpenClaw gateway process can read `PROMPTLAYER_API_KEY` or `plugins.entries.openclaw-promptlayer.config.apiKey`.

## Recommended Config Templates

### Minimal

Use this when the user wants the safest starting point:

```json
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {}
      }
    }
  }
}
```

### With Provider Mapping

Use this when OpenClaw provider ids need to be mapped to OTEL GenAI provider names:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          // Use PROMPTLAYER_API_KEY in the environment unless the user explicitly
          // wants to keep the API key in config.
          "environment": "production",
          "serviceName": "openclaw-agent",
          "providerNameMap": {
            "customprovider": "openai"
          }
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
| `apiKey` | `""` | Prefer `PROMPTLAYER_API_KEY`. Without an API key, the plugin disables itself. |
| `endpoint` | `https://api.promptlayer.com/v1/traces` | PromptLayer OTLP/HTTP traces endpoint. |
| `environment` | `development` | Falls back to `PROMPTLAYER_ENVIRONMENT`. |
| `serviceName` | `openclaw-agent` | OTEL `service.name`. |
| `providerName` | `""` | Falls back to `PROMPTLAYER_PROVIDER_NAME`. |
| `providerNameMap` | `{}` | Useful for ids such as `customprovider -> openai`. |
| `resourceAttributes` | `{}` | Additional OTEL resource attributes. |
| `spanProcessorType` | `batch` | Use `simple` for exporter debugging. |
| `batchConfig.maxQueueSize` | `2048` | Batch exporter queue size. |
| `batchConfig.maxExportBatchSize` | `512` | Batch size limit. |
| `batchConfig.scheduledDelayMs` | `5000` | Batch delay. |

## Behavior Notes The Agent Should Know

- The plugin exports traces, not metrics.
- The plugin creates `invoke_agent`, `chat`, and `execute_tool` spans.
- Chat spans are emitted from `llm_output`, not directly from `llm_input`.
- Chat spans emit modern `gen_ai.input.messages` and `gen_ai.output.messages` JSON attributes when message data is available.
- Thinking/reasoning content is preserved as `thinking` parts inside `gen_ai.output.messages`.
- `agent_end` may wait briefly for pending `llm_output` processing before finalizing the root span.
- Non-bundled OpenClaw plugins need `hooks.allowConversationAccess: true` to receive raw conversation hooks such as `llm_input`, `llm_output`, and `agent_end`.

## Payload Notes

- The plugin does not redact or truncate message, tool argument, or tool result attributes.
- Keep the API key in the environment, not in committed config.

## Troubleshooting Checklist

If traces do not appear:

1. Check that `PROMPTLAYER_API_KEY` exists in the OpenClaw runtime environment, or that `apiKey` is configured.
2. Check that the plugin key is exactly `openclaw-promptlayer`.
3. Check that `plugins.entries.openclaw-promptlayer.hooks.allowConversationAccess` is `true`.
4. Check that OpenClaw was restarted after config or environment changes.
5. Check that OpenClaw is new enough to emit `llm_input`, `llm_output`, and `before_tool_call`.
6. Check network access to the configured endpoint.
7. Check OpenClaw logs for `PromptLayer trace export failed`.

If chat spans are missing or incomplete:

1. Check whether `llm_input` and `llm_output` are emitted for the run.
2. Check whether `llm_output` includes `lastAssistant` or `assistantTexts`.
3. Check whether the run only produced tool calls without a completed assistant payload.

## Output Guidance

When helping a user:

- prefer a minimal config first
- never echo or commit a real API key
- redact any shared secrets when quoting `openclaw.json`
- use `endpoint` only for the OTLP traces endpoint
