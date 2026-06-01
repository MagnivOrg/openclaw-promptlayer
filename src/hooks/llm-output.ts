// SPDX-License-Identifier: MIT
/**
 * Hook: llm_output
 *
 * Fires after each LLM API call with the response and token usage.
 * Reconstructs chat spans after each LLM call and accumulates token usage.
 */

import { spanStore, type LlmSpanEntry } from '../context/span-store.js';
import { maybeFinalizeDeferredAgentEnd } from './agent-end.js';
import {
  resolveProviderName,
  buildAssistantMessagesFromTexts,
  buildPydanticAiAllMessages,
  normalizeToGenAiOutputMessages,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import type { LlmContext } from './llm-input.js';
import { createChatSpan, hasTextOutput, hasToolCall } from './chat-span.js';

/** OpenClaw llm_output event payload (minimal — only fields we use). */
export interface LlmOutputEvent {
  runId: string;
  provider: string;
  model: string;
  /** 流式拼接后的纯文本输出，可在 lastAssistant 不完整时兜底。 */
  assistantTexts?: string[];
  /** 当轮 assistant 消息（OpenAI/Anthropic/Google 等格式），用于 gen_ai.output.messages */
  lastAssistant?: unknown;
  /** 当轮结束原因，如 'stop' | 'tool_call' | 'length' 等 */
  finishReason?: string;
  /** 若 provider SDK 暴露 response id，可直接透传。 */
  responseId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/** Type guard for finite numbers (handles zero correctly). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function handleLlmOutput(
  event: LlmOutputEvent,
  ctx: LlmContext,
  config: PromptLayerPluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  const resolvedProvider =
    resolveProviderName(event.provider, config.providerNameMap) || event.provider;

  session.model = event.model;
  session.provider = resolvedProvider;

  const llmEntry = spanStore.deleteLlmSpan(sessionKey, event.runId);
  const usage = event.usage;

  // Accumulate tokens on the session (use numeric validation, not truthy)
  if (usage) {
    if (isFiniteNumber(usage.input)) session.tokens.input += usage.input;
    if (isFiniteNumber(usage.output)) session.tokens.output += usage.output;
    if (isFiniteNumber(usage.cacheRead)) session.tokens.cacheRead += usage.cacheRead;
    if (isFiniteNumber(usage.cacheWrite)) session.tokens.cacheWrite += usage.cacheWrite;
  }

  try {
    const spanEntry: LlmSpanEntry =
      llmEntry ??
      {
        runId: event.runId,
        sessionKey,
        agentName: ctx.agentId || 'agent',
        provider: resolvedProvider,
        model: event.model,
        startTime: Date.now(),
        inputMessages: [],
        systemInstructions: [],
      };
    const llmEndTime = Math.max(Date.now(), spanEntry.startTime);
    const candidateOutputMessages =
      event.lastAssistant != null
        ? normalizeToGenAiOutputMessages(event.lastAssistant, event.finishReason)
        : [];
    const fallbackOutputMessages = buildAssistantMessagesFromTexts(
      event.assistantTexts,
      event.finishReason,
    );
    const outputMessages =
      hasTextOutput(candidateOutputMessages) || fallbackOutputMessages.length === 0
        ? candidateOutputMessages
        : fallbackOutputMessages;

    if (llmEntry || outputMessages.length > 0) {
      const hasObservedTools =
        session.toolSequence > 0 || (session.completedToolCalls ?? []).length > 0;
      if (hasObservedTools) {
        spanEntry.outputMessages = outputMessages;
        spanEntry.finishReason = event.finishReason;
        spanEntry.responseId = event.responseId;
        spanEntry.usage = usage;
        spanEntry.endTime = llmEndTime;
        spanStore.addCompletedLlmCall(sessionKey, spanEntry);
      } else {
        createChatSpan(
          spanEntry,
          spanEntry.inputMessages,
          outputMessages,
          session.agentCtx,
          event.finishReason,
          event.responseId,
          usage,
          llmEndTime,
          config,
        );
      }
      session.latestAllMessages =
        buildPydanticAiAllMessages(spanEntry.inputMessages, outputMessages);
      session.latestSystemInstructions = spanEntry.systemInstructions;
      session.lastChatEndTime = llmEndTime;
      session.lastChatHadTextOutput = hasTextOutput(outputMessages);
      session.lastChatHadToolCall = hasToolCall(outputMessages);
    }
  } finally {
    maybeFinalizeDeferredAgentEnd(sessionKey);
  }
}
