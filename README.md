# @promptlayer/openclaw-promptlayer

[![npm version](https://img.shields.io/npm/v/@promptlayer/openclaw-promptlayer)](https://www.npmjs.com/package/@promptlayer/openclaw-promptlayer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`openclaw-promptlayer` exports OpenClaw agent activity to PromptLayer as OpenTelemetry GenAI traces.

It captures the execution shape of an OpenClaw run:

- one root `invoke_agent <agent>` span per agent invocation
- one `chat <model>` span per LLM call, reconstructed from `llm_input` and `llm_output`
- one `execute_tool <tool>` span per tool call
- token usage on chat spans when OpenClaw exposes usage data
- GenAI message, tool argument, and tool result attributes as OTEL span attributes

## Requirements

- OpenClaw `>= 2026.2.1`
- Node.js `>= 20`
- A PromptLayer API key
- Network access to `https://api.promptlayer.com/v1/traces`

## Install

Install the plugin:

```bash
openclaw plugins install @promptlayer/openclaw-promptlayer
```

Set your PromptLayer API key in the environment that OpenClaw runs with:

```bash
export PROMPTLAYER_API_KEY="<your-api-key>"
```

Then enable the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

The plugin id must be `openclaw-promptlayer`.

## Quick Start

Production configuration:

```json
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Restart OpenClaw after changing config. The plugin reads `PROMPTLAYER_API_KEY` at runtime and exports traces to PromptLayer's OTLP endpoint.

If no API key is available, the plugin disables itself and logs an error instead of starting half-configured.

## Configuration

Use config only when you need to override the endpoint, environment labels, service name, or provider mapping:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-promptlayer": {
        "enabled": true,
        "config": {
          // Prefer PROMPTLAYER_API_KEY in the environment.
          // You can set "apiKey" here, but env vars are safer.
          "environment": "production",
          "serviceName": "openclaw-agent",

          // Map non-standard OpenClaw provider ids to OTEL GenAI provider names.
          "providerNameMap": {
            "customprovider": "openai"
          },

          "spanProcessorType": "batch"
        }
      }
    }
  }
}
```

Notes:

- Message, tool argument, and tool result attributes are exported as normal OTEL span attributes.
- `spanProcessorType: "simple"` is useful when debugging exporter behavior because spans are exported immediately.

## What The Plugin Captures

### Span tree

A typical trace looks like this:

```text
invoke_agent main
  |- chat gpt-5.4
  |- execute_tool Read
  |- execute_tool Shell
  `- chat gpt-5.4
```

### Root span

The root `invoke_agent <agent>` span stores:

- conversation id and session id
- agent name and id
- workspace and channel metadata when available
- request duration and tool count
- error status and exception details when the agent fails

The root span intentionally does not duplicate full request-log payloads or aggregate token fields. Per-call model, message, tool, and usage details live on the child spans.

### Chat spans

Each LLM call becomes a `chat <model>` span after OpenClaw emits `llm_output`.

Chat spans include:

- `gen_ai.operation.name = "chat"`
- `gen_ai.agent.name`
- `gen_ai.conversation.id`
- `gen_ai.provider.name`
- `gen_ai.system`
- request/response model attributes
- `openclaw.llm.run_id`
- token usage attributes when provided by OpenClaw
- `gen_ai.input.messages`, `gen_ai.output.messages`, thinking/reasoning parts, system instructions, and tool definitions when available

If `lastAssistant` is unavailable or incomplete, the plugin can fall back to `assistantTexts`. When an agent ends before the final `llm_output` has arrived, finalization waits briefly so the final chat span can still be emitted.

### Tool spans

Each tool call becomes `execute_tool <tool>`.

Tool spans include:

- `gen_ai.operation.name = "execute_tool"`
- `gen_ai.tool.name`
- `gen_ai.tool.call.id`
- `gen_ai.tool.type = "function"`
- OpenClaw tool sequence
- duration and output size metadata
- tool arguments and result payloads when available

Tool-level error details are not always available in OpenClaw's tool persistence hook. Agent-level failures are recorded on the root span.

## Configuration Reference

All config lives under `plugins.entries.openclaw-promptlayer.config`.

### Environment variable fallbacks

| Variable | Used for | Notes |
|---|---|---|
| `PROMPTLAYER_API_KEY` | `apiKey` | Required at runtime unless `apiKey` is set directly |
| `PROMPTLAYER_ENVIRONMENT` | `environment` | Defaults to `development` |
| `PROMPTLAYER_PROVIDER_NAME` | `providerName` | Optional default GenAI provider name |

### Runtime options

| Key | Type | Default | Description |
|---|---|---:|---|
| `apiKey` | `string` | `""` | PromptLayer API key. Prefer `PROMPTLAYER_API_KEY` instead of committing it into config. |
| `endpoint` | `string` | `https://api.promptlayer.com/v1/traces` | PromptLayer OTLP/HTTP traces endpoint. |
| `environment` | `string` | `development` | Deployment environment resource attribute. |
| `serviceName` | `string` | `openclaw-agent` | OTEL `service.name`. |
| `providerName` | `string` | `""` | Default provider name when OpenClaw metadata does not provide one. |
| `providerNameMap` | `Record<string, string>` | `{}` | Maps OpenClaw provider ids to OTEL provider names. |
| `resourceAttributes` | `Record<string, string>` | `{}` | Additional OTEL resource attributes. |
| `spanProcessorType` | `"batch" \| "simple"` | `batch` | Use `simple` when debugging exporter behavior. |
| `batchConfig.maxQueueSize` | `integer` | `2048` | Batch span processor queue size. |
| `batchConfig.maxExportBatchSize` | `integer` | `512` | Maximum spans per export batch. |
| `batchConfig.scheduledDelayMs` | `integer` | `5000` | Delay between batch exports. |

## Privacy And Safety Notes

- Traces can contain messages, tool arguments, tool results, and system instructions.
- The plugin does not redact or truncate captured payload attributes.
- Prefer `PROMPTLAYER_API_KEY` in the runtime environment instead of committing API keys into `openclaw.json`.

## Troubleshooting

### No traces appear

Check these first:

1. `PROMPTLAYER_API_KEY` is set in the environment seen by OpenClaw, or `apiKey` is set in plugin config.
2. The plugin entry key is exactly `openclaw-promptlayer`.
3. OpenClaw is at least `2026.2.1`.
4. OpenClaw was restarted after config or environment changes.
5. Your machine can reach the configured endpoint.
6. OpenClaw logs do not show `PromptLayer trace export failed`.

### Chat spans are missing or incomplete

Make sure OpenClaw emits `llm_input` and `llm_output` for the run. The plugin creates chat spans from those hook events, and the richest output requires `llm_output.lastAssistant` or `llm_output.assistantTexts`.

### Tool spans do not show failures clearly

OpenClaw does not always expose tool-level error details in `tool_result_persist`. In those cases, failures may be reflected on the root agent span instead of the individual tool span.

## Local Development

```bash
git clone https://github.com/MagnivOrg/openclaw-promptlayer
cd openclaw-promptlayer
npm install
npm run build
```

To load the local checkout in OpenClaw, symlink it into your extensions directory or add the repo path to `plugins.load.paths`.

```bash
ln -s "$(pwd)" ~/.openclaw/extensions/openclaw-promptlayer
```

Or:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-promptlayer"
      ]
    }
  }
}
```

Then export `PROMPTLAYER_API_KEY`, restart OpenClaw, and verify with:

```bash
openclaw plugins list
```

## Origins

This project began as a repurposed fork of the OpenClaw Logfire plugin. The current PromptLayer integration has diverged substantially; this documentation describes the current PromptLayer behavior.

## License

MIT
