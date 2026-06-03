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
import { handleBeforePromptBuild } from './before-agent-start.js';

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

/** OpenClaw agent context shared by LLM and agent lifecycle hooks. */
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
    handleBeforePromptBuild(
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
  // Keep the latest LLM call id and input preview for agent error logs.
  session.lastLlmRunId = event.runId;
  session.lastLlmPrompt = prepareForCapture(event.prompt);

  if (resolvedProvider && config.providerName === '') {
    session.agentSpan.setAttribute('gen_ai.provider.name', resolvedProvider);
  }

  const systemInstructions = buildSystemInstructions(event.systemPrompt);
  const hasRawHistoryMessages =
    Array.isArray(event.historyMessages) && event.historyMessages.length > 0;

  const historyMessages = hasRawHistoryMessages
    ? buildFullInputMessages(event.systemPrompt, event.historyMessages, event.prompt)
    : session.initialHistoryMessages ?? [];
  const hasSystemMessageInHistory = historyMessages.some(
    (message) => message.role === 'system',
  );
  const fullInput =
    hasRawHistoryMessages
      ? historyMessages
      : [
          ...(!hasSystemMessageInHistory && systemInstructions.length > 0
            ? [{ role: 'system', parts: systemInstructions }]
            : []),
          ...historyMessages,
          {
            role: 'user',
            parts: [{ type: 'text', content: event.prompt }],
          },
        ];

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
