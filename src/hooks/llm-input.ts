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
} from '../util.js';
import type { LogfirePluginConfig } from '../config.js';

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
  config: LogfirePluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
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

  // 完整 gen_ai.input.messages（system + 历史 + 当前用户轮）供 Logfire 正确解析多轮/工具/思考
  let fullInput: ReturnType<typeof buildFullInputMessages> = [];
  if (config.captureMessageContent || config.captureHistoryMessages) {
    if (hasRawHistoryMessages) {
      fullInput = buildFullInputMessages(
        event.systemPrompt,
        event.historyMessages,
        event.prompt,
      );
    } else {
      const normalizedSessionHistory = session.initialHistoryMessages ?? [];
      const hasSystemMessageInHistory = normalizedSessionHistory.some(
        (message) => message.role === 'system',
      );
      fullInput = [
        ...(hasSystemMessageInHistory
          ? []
          : systemInstructions.length > 0
            ? [{ role: 'system', parts: systemInstructions }]
            : []),
        ...normalizedSessionHistory,
        {
          role: 'user',
          parts: [{ type: 'text', content: event.prompt }],
        },
      ];
    }
  }

  spanStore.setLlmSpan(sessionKey, event.runId, {
    runId: event.runId,
    agentName: ctx.agentId || 'agent',
    provider: resolvedProvider,
    model: event.model,
    startTime: Date.now(),
    inputMessages: fullInput,
    systemInstructions,
  });

  session.latestSystemInstructions = systemInstructions;
  if (fullInput.length > 0) {
    session.latestAllMessages = fullInput;
  }
}
