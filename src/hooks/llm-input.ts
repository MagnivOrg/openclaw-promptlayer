// SPDX-License-Identifier: MIT
/**
 * Hook: llm_input
 *
 * Fires before each LLM API call with the full request context.
 * Creates a `gen_ai.chat` child span per LLM invocation and stores
 * model/provider on the session for later use in metrics.
 */

import { spanStore } from '../context/span-store.js';
import {
  prepareForCapture,
  buildFullInputMessages,
  buildSystemInstructions,
  resolveProviderName,
  normalizeToGenAiToolDefinitions,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import { handleBeforeAgentStart } from './before-agent-start.js';

/** OpenClaw llm_input event payload (minimal — only fields we use). */
export interface LlmInputEvent {
  runId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  /** Full message list before this prompt (OpenClaw sends historyMessages). */
  historyMessages?: unknown[];
  imagesCount: number;
  tools?: unknown[];
}

/** OpenClaw agent context (shared with before_agent_start, agent_end, etc.). */
export interface LlmContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export function handleLlmInput(
  event: LlmInputEvent,
  ctx: LlmContext,
  config: PromptLayerPluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  let session = spanStore.get(sessionKey);
  if (!session) {
    handleBeforeAgentStart(
      { prompt: event.prompt, messages: event.historyMessages },
      ctx,
      config,
    );
    session = spanStore.get(sessionKey);
  }
  if (!session) return;

  const resolvedProvider =
    resolveProviderName(event.provider, config.providerNameMap) ||
    event.provider ||
    config.providerName ||
    'unknown';

  session.model = event.model;
  session.provider = resolvedProvider;
  // 保存最后一次 LLM 调用的 runId 与输入摘要，供 agent 出错时日志使用
  session.lastLlmRunId = event.runId;
  session.lastLlmPrompt = prepareForCapture(
    event.prompt,
    600,
    config.redactSecrets,
  );

  if (resolvedProvider && config.providerName === '') {
    session.agentSpan.setAttribute('gen_ai.provider.name', resolvedProvider);
  }

  const systemInstructions = buildSystemInstructions(event.systemPrompt);
  const hasRawHistoryMessages =
    Array.isArray(event.historyMessages) && event.historyMessages.length > 0;

  // By default, capture only this turn's prompt. Full history can be very large
  // and is opt-in via captureHistoryMessages.
  let fullInput: ReturnType<typeof buildFullInputMessages> = [];
  if (config.captureMessageContent || config.captureHistoryMessages) {
    if (config.captureHistoryMessages && hasRawHistoryMessages) {
      fullInput = buildFullInputMessages(
        event.systemPrompt,
        event.historyMessages,
        event.prompt,
      );
    } else {
      const initialHistoryMessages = config.captureHistoryMessages
        ? session.initialHistoryMessages ?? []
        : [];
      const hasSystemMessageInHistory = initialHistoryMessages.some(
        (message) => message.role === 'system',
      );
      fullInput = [
        ...(!hasSystemMessageInHistory && systemInstructions.length > 0
          ? [{ role: 'system', parts: systemInstructions }]
          : []),
        ...initialHistoryMessages,
        {
          role: 'user',
          parts: [{ type: 'text', content: event.prompt }],
        },
      ];
    }
  }

  spanStore.setLlmSpan(sessionKey, event.runId, {
    runId: event.runId,
    sessionKey,
    agentName: ctx.agentId || 'agent',
    provider: resolvedProvider,
    model: event.model,
    startTime: Date.now(),
    inputMessages: fullInput,
    systemInstructions,
    toolDefinitions: normalizeToGenAiToolDefinitions(event.tools),
  });

  session.latestSystemInstructions = systemInstructions;
  if (fullInput.length > 0) {
    session.latestAllMessages = fullInput;
  }
}
