// SPDX-License-Identifier: MIT
import { resolveConfig } from './config.js';
import { initializeOtel } from './otel.js';
import { handleBeforeAgentStart } from './hooks/before-agent-start.js';
import { handleBeforeToolCall } from './hooks/before-tool-call.js';
import { handleToolResultPersist } from './hooks/tool-result-persist.js';
import { handleAgentEnd } from './hooks/agent-end.js';
import { handleLlmInput } from './hooks/llm-input.js';
import { handleLlmOutput } from './hooks/llm-output.js';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { BeforeAgentStartEvent, AgentContext } from './hooks/before-agent-start.js';
import type { BeforeToolCallEvent, ToolContext } from './hooks/before-tool-call.js';
import type { ToolResultPersistEvent, ToolResultPersistContext } from './hooks/tool-result-persist.js';
import type { AgentEndEvent } from './hooks/agent-end.js';
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

export default function register(api: PluginApi): void {
  const config = resolveConfig(api.pluginConfig);

  if (!config.apiKey) {
    api.logger.error(
      'PromptLayer plugin disabled: PROMPTLAYER_API_KEY not set. ' +
        'Export it as an env var or set plugin config apiKey.',
    );
    return;
  }

  try {
    sdk = initializeOtel(config);
  } catch (err) {
    api.logger.error(`PromptLayer plugin init failed: ${err}`);
    return;
  }

  api.on('before_agent_start', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeAgentStart(
        event as unknown as BeforeAgentStartEvent,
        ctx as unknown as AgentContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`PromptLayer before_agent_start error: ${err}`);
    }
  });

  api.on('before_tool_call', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleBeforeToolCall(
        event as unknown as BeforeToolCallEvent,
        ctx as unknown as ToolContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`PromptLayer before_tool_call error: ${err}`);
    }
  });

  api.on('tool_result_persist', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleToolResultPersist(
        event as unknown as ToolResultPersistEvent,
        ctx as unknown as ToolResultPersistContext,
        config,
      );
    } catch (err) {
      api.logger.warn(`PromptLayer tool_result_persist error: ${err}`);
    }
  });

  api.on('agent_end', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleAgentEnd(
        event as unknown as AgentEndEvent,
        ctx as unknown as AgentContext,
        config,
        api.logger,
      );
    } catch (err) {
      api.logger.warn(`PromptLayer agent_end error: ${err}`);
    }
  });

  api.on('llm_input', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmInput(event as unknown as LlmInputEvent, ctx as unknown as LlmContext, config);
    } catch (err) {
      api.logger.warn(`PromptLayer llm_input error: ${err}`);
    }
  });

  api.on('llm_output', (event, ctx) => {
    if (!isRecord(event) || !isRecord(ctx)) return;
    try {
      handleLlmOutput(event as unknown as LlmOutputEvent, ctx as unknown as LlmContext, config);
    } catch (err) {
      api.logger.warn(`PromptLayer llm_output error: ${err}`);
    }
  });

  api.registerService({
    id: 'promptlayer-otel',
    start: () => {
      api.logger.info(
        `PromptLayer: exporting traces to ${config.endpoint} (service: ${config.serviceName}, env: ${config.environment})`,
      );
    },
    stop: async () => {
      if (sdk) {
        await sdk.shutdown();
        api.logger.info('PromptLayer: OTEL SDK shut down');
      }
    },
  });
}
