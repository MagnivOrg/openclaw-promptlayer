// SPDX-License-Identifier: MIT
/**
 * @shichen335/openclaw-logfire
 *
 * Pydantic Logfire observability plugin for OpenClaw.
 * OTEL GenAI semantic convention compliant.
 *
 * Minimal setup:
 *   1. Set LOGFIRE_TOKEN env var
 *   2. Add to openclaw.json:
 *      { "plugins": { "entries": { "openclaw-logfire": { "enabled": true, "config": {} } } } }
 *   3. Restart OpenClaw
 */

import { resolveConfig } from './config.js';
import { initializeOtel } from './otel.js';
import { handleBeforeAgentStart } from './hooks/before-agent-start.js';
import { handleBeforeToolCall } from './hooks/before-tool-call.js';
import { handleToolResultPersist } from './hooks/tool-result-persist.js';
import { handleAgentEnd } from './hooks/agent-end.js';
import { handleMessageReceived } from './hooks/message-received.js';
import { handleLlmInput } from './hooks/llm-input.js';
import { handleLlmOutput } from './hooks/llm-output.js';
import { persistRawHookPayload } from './hook-raw-log.js';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { BeforeAgentStartEvent, AgentContext } from './hooks/before-agent-start.js';
import type { BeforeToolCallEvent, ToolContext } from './hooks/before-tool-call.js';
import type { ToolResultPersistEvent, ToolResultPersistContext } from './hooks/tool-result-persist.js';
import type { AgentEndEvent } from './hooks/agent-end.js';
import type { MessageReceivedEvent, MessageContext } from './hooks/message-received.js';
import type { LlmInputEvent, LlmContext } from './hooks/llm-input.js';
import type { LlmOutputEvent } from './hooks/llm-output.js';

/**
 * Minimal OpenClaw plugin API contract.
 * We type only what we actually use to avoid tight coupling
 * to a specific OpenClaw version.
 */
interface PluginApi {
  /** Full application config (openclaw.json). */
  config?: Record<string, unknown>;
  /** Plugin-specific config from plugins.entries.<id>.config. */
  pluginConfig?: Record<string, unknown>;
  logger: {
    info(msg: string): void;
    debug(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
  registerService(service: {
    id: string;
    start: () => void;
    stop: () => void | Promise<void>;
  }): void;
}

/** Runtime guard for untrusted hook payloads from the OpenClaw SDK. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

let sdk: NodeSDK | null = null;

function persistRawHookPayloadIfEnabled(
  enabled: boolean,
  hook: string,
  event: unknown,
  ctx: unknown,
): void {
  if (!enabled) return;
  persistRawHookPayload(hook, event, ctx);
}

export default function register(api: PluginApi): void {
  // pluginConfig is the plugin-specific config from plugins.entries.<id>.config.
  // api.config is the full openclaw.json — DO NOT use it for plugin settings.
  const config = resolveConfig(api.pluginConfig);

  // Validate token
  if (!config.token) {
    api.logger.error(
      'Logfire plugin disabled: LOGFIRE_TOKEN not set. ' +
        'Export it as an env var or set plugins.entries.openclaw-logfire.config.token',
    );
    return;
  }

  // Initialize OTEL SDK
  try {
    sdk = initializeOtel(config);
  } catch (err) {
    api.logger.error(`Logfire plugin init failed: ${err}`);
    return;
  }

  // Register lifecycle hooks — OpenClaw passes (event, ctx) to each handler.
  // Types are asserted at the boundary since the SDK provides untyped payloads.
  api.on('before_agent_start', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'before_agent_start', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeAgentStart(
        event as unknown as BeforeAgentStartEvent,
        ctx as unknown as AgentContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`Logfire before_agent_start error: ${err}`);
    }
  });

  api.on('before_tool_call', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'before_tool_call', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeToolCall(
        event as unknown as BeforeToolCallEvent,
        ctx as unknown as ToolContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`Logfire before_tool_call error: ${err}`);
    }
  });

  api.on('tool_result_persist', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'tool_result_persist', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleToolResultPersist(
        event as unknown as ToolResultPersistEvent,
        ctx as unknown as ToolResultPersistContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`Logfire tool_result_persist error: ${err}`);
    }
  });

  api.on('agent_end', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'agent_end', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleAgentEnd(
        event as unknown as AgentEndEvent,
        ctx as unknown as AgentContext,
        config,
        api.logger,
      );
    } catch (err) {
      api.logger.warn(`Logfire agent_end error: ${err}`);
    }
  });

  api.on('message_received', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'message_received', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleMessageReceived(
        event as unknown as MessageReceivedEvent,
        ctx as unknown as MessageContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`Logfire message_received error: ${err}`);
    }
  });

  api.on('llm_input', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'llm_input', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmInput(event as unknown as LlmInputEvent, ctx as unknown as LlmContext, config);
    } catch (err) {
      api.logger.warn(`Logfire llm_input error: ${err}`);
    }
  });

  api.on('llm_output', (event, ctx) => {
    persistRawHookPayloadIfEnabled(config.saveHookLogs, 'llm_output', event, ctx);
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmOutput(event as unknown as LlmOutputEvent, ctx as unknown as LlmContext, config);
    } catch (err) {
      api.logger.warn(`Logfire llm_output error: ${err}`);
    }
  });

  // Register service for clean shutdown
  api.registerService({
    id: 'logfire-otel',
    start: () => {
      const region = config.region === 'eu' ? 'EU' : 'US';
      api.logger.info(
        `Logfire: exporting to ${region} (service: ${config.serviceName}, env: ${config.environment})`,
      );
    },
    stop: async () => {
      if (sdk) {
        await sdk.shutdown();
        api.logger.info('Logfire: OTEL SDK shut down');
      }
    },
  });
}
