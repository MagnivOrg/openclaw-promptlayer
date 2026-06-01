// SPDX-License-Identifier: MIT
/**
 * Hook: llm_output
 *
 * Fires after each LLM API call with the response and token usage.
 * Reconstructs chat spans after each LLM call and accumulates token usage.
 */

import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { spanStore, type CompletedToolCall, type LlmSpanEntry } from '../context/span-store.js';
import { maybeFinalizeDeferredAgentEnd } from './agent-end.js';
import {
  resolveProviderName,
  resolveGenAiSystemName,
  prepareForCapture,
  buildAssistantMessagesFromTexts,
  buildMessagesFromConversationHistory,
  buildPydanticAiAllMessages,
  extractConversationOutputMessages,
  extractFinalResult,
  normalizeToGenAiOutputMessages,
  type GenAiChatMessage,
  safeJsonStringify,
  INSTRUMENTATION_SCOPE_NAME,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import type { LlmContext } from './llm-input.js';

const CHAT_TOOL_BOUNDARY_GAP_MS = 1;
const TOOL_GROUP_LEAD_MS = 2;
const TOOL_GROUP_TAIL_MS = 2;

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

function hasVisibleAssistantText(messages: ReturnType<typeof normalizeToGenAiOutputMessages>): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        (part.type === 'text' || part.type === 'thinking') &&
        typeof part.content === 'string' &&
        part.content.trim() !== '',
    ),
  );
}

interface ChatPhase {
  inputMessages: GenAiChatMessage[];
  outputMessages: GenAiChatMessage[];
  startTime: number;
  endTime: number;
}

type UsageSummary = NonNullable<LlmOutputEvent['usage']>;

function stripLeadingSystemMessages(messages: GenAiChatMessage[]): GenAiChatMessage[] {
  let firstNonSystemIndex = 0;
  while (
    firstNonSystemIndex < messages.length &&
    messages[firstNonSystemIndex]?.role === 'system'
  ) {
    firstNonSystemIndex += 1;
  }
  return messages.slice(firstNonSystemIndex);
}

function isToolResponseMessage(message: GenAiChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'tool_call_response')
  );
}

function countToolCalls(messages: GenAiChatMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.parts.filter((part) => part.type === 'tool_call').length,
    0,
  );
}

function messagesAreEquivalent(left: GenAiChatMessage, right: GenAiChatMessage): boolean {
  return safeJsonStringify(left) === safeJsonStringify(right);
}

function extractConversationOutputRawMessages(
  fullConversationRawMessages: unknown[] | undefined,
  inputMessages: GenAiChatMessage[],
): unknown[] {
  if (!Array.isArray(fullConversationRawMessages) || fullConversationRawMessages.length === 0) {
    return [];
  }

  const fullConversationMessages = buildMessagesFromConversationHistory(fullConversationRawMessages);
  const comparableInputMessages = inputMessages.filter((message) => message.role !== 'system');
  if (comparableInputMessages.length === 0) {
    return [...fullConversationRawMessages];
  }
  if (fullConversationMessages.length < comparableInputMessages.length) {
    return [];
  }

  const prefixMatches = comparableInputMessages.every((message, index) =>
    messagesAreEquivalent(message, fullConversationMessages[index]),
  );
  if (!prefixMatches) {
    return [...fullConversationRawMessages];
  }

  return fullConversationRawMessages.slice(comparableInputMessages.length);
}

function mergeUsageSummaries(
  left: UsageSummary | undefined,
  right: LlmOutputEvent['usage'] | undefined,
): UsageSummary | undefined {
  if (!right) return left;

  const mergedInput = (left?.input ?? 0) + (isFiniteNumber(right.input) ? right.input : 0);
  const mergedOutput = (left?.output ?? 0) + (isFiniteNumber(right.output) ? right.output : 0);
  const mergedCacheRead =
    (left?.cacheRead ?? 0) + (isFiniteNumber(right.cacheRead) ? right.cacheRead : 0);
  const mergedCacheWrite =
    (left?.cacheWrite ?? 0) + (isFiniteNumber(right.cacheWrite) ? right.cacheWrite : 0);
  const merged: UsageSummary = {
    input: mergedInput,
    output: mergedOutput,
    cacheRead: mergedCacheRead,
    cacheWrite: mergedCacheWrite,
  };

  const totalValue =
    (isFiniteNumber(left?.total) ? left.total : 0) + (isFiniteNumber(right.total) ? right.total : 0);
  if (totalValue > 0) {
    merged.total = totalValue;
  }

  const hasAnyUsage =
    mergedInput > 0 ||
    mergedOutput > 0 ||
    mergedCacheRead > 0 ||
    mergedCacheWrite > 0 ||
    merged.total !== undefined;
  return hasAnyUsage ? merged : left;
}

function countRawAssistantToolCalls(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const rawMessage = message as Record<string, unknown>;
  const toolCalls = rawMessage.tool_calls;
  const content = rawMessage.content;

  let count = 0;
  if (Array.isArray(toolCalls)) {
    count += toolCalls.length;
  }
  if (Array.isArray(content)) {
    count += content.filter((part) => {
      if (!part || typeof part !== 'object') return false;
      const rawPart = part as Record<string, unknown>;
      return rawPart.type === 'toolCall' || rawPart.type === 'tool_use';
    }).length;
  }
  return count;
}

function extractUsageFromRawAssistantMessage(message: unknown): LlmOutputEvent['usage'] | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const rawMessage = message as Record<string, unknown>;
  const usage = rawMessage.usage;
  if (!usage || typeof usage !== 'object') return undefined;

  const rawUsage = usage as Record<string, unknown>;
  const extractedUsage: UsageSummary = {};
  if (isFiniteNumber(rawUsage.input)) extractedUsage.input = rawUsage.input;
  if (isFiniteNumber(rawUsage.output)) extractedUsage.output = rawUsage.output;
  if (isFiniteNumber(rawUsage.cacheRead)) extractedUsage.cacheRead = rawUsage.cacheRead;
  if (isFiniteNumber(rawUsage.cacheWrite)) extractedUsage.cacheWrite = rawUsage.cacheWrite;
  if (isFiniteNumber(rawUsage.totalTokens)) extractedUsage.total = rawUsage.totalTokens;
  if (isFiniteNumber(rawUsage.total)) extractedUsage.total = rawUsage.total;

  return Object.keys(extractedUsage).length > 0 ? extractedUsage : undefined;
}

function buildPhaseUsages(outputRawMessages: unknown[]): Array<LlmOutputEvent['usage'] | undefined> {
  const phaseUsages: Array<LlmOutputEvent['usage'] | undefined> = [];
  let currentPhaseSeenAssistant = false;
  let currentPhaseUsage: UsageSummary | undefined;

  for (const rawMessage of outputRawMessages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const role = (rawMessage as Record<string, unknown>).role;
    if (role !== 'assistant') continue;

    currentPhaseSeenAssistant = true;
    currentPhaseUsage = mergeUsageSummaries(
      currentPhaseUsage,
      extractUsageFromRawAssistantMessage(rawMessage),
    );

    if (countRawAssistantToolCalls(rawMessage) > 0) {
      phaseUsages.push(currentPhaseUsage);
      currentPhaseSeenAssistant = false;
      currentPhaseUsage = undefined;
    }
  }

  if (currentPhaseSeenAssistant) {
    phaseUsages.push(currentPhaseUsage);
  }

  return phaseUsages;
}

function buildChatPhases(
  inputMessages: GenAiChatMessage[],
  outputMessages: GenAiChatMessage[],
  completedTools: CompletedToolCall[],
  llmStartTime: number,
  llmEndTime: number,
): ChatPhase[] {
  if (outputMessages.length === 0) {
    return [
      {
        inputMessages: [...inputMessages],
        outputMessages: [],
        startTime: llmStartTime,
        endTime: llmEndTime,
      },
    ];
  }

  const phases: ChatPhase[] = [];
  let phaseInputMessages = [...inputMessages];
  let phaseOutputMessages: GenAiChatMessage[] = [];
  let phaseStartTime = llmStartTime;
  let toolCursor = 0;

  const emitPhase = (endTime: number): void => {
    if (phaseOutputMessages.length === 0) return;
    phases.push({
      inputMessages: [...phaseInputMessages],
      outputMessages: [...phaseOutputMessages],
      startTime: phaseStartTime,
      endTime: Math.max(phaseStartTime, endTime),
    });
    phaseInputMessages = [...phaseInputMessages, ...phaseOutputMessages];
    phaseOutputMessages = [];
  };

  for (const message of outputMessages) {
    if (message.role === 'assistant') {
      phaseOutputMessages.push(message);
      const toolCallCount = countToolCalls([message]);
      if (toolCallCount > 0) {
        const matchedTools = completedTools.slice(toolCursor, toolCursor + toolCallCount);
        emitPhase(
          matchedTools[0] != null
            ? matchedTools[0].startTime - TOOL_GROUP_LEAD_MS - CHAT_TOOL_BOUNDARY_GAP_MS
            : llmEndTime,
        );
        toolCursor += toolCallCount;
        const lastMatchedTool = matchedTools.at(-1);
        if (lastMatchedTool) {
          phaseStartTime = lastMatchedTool.endTime + TOOL_GROUP_TAIL_MS + CHAT_TOOL_BOUNDARY_GAP_MS;
        }
      }
      continue;
    }

    if (isToolResponseMessage(message)) {
      phaseInputMessages = [...phaseInputMessages, message];
      continue;
    }

    phaseInputMessages = [...phaseInputMessages, message];
  }

  if (phaseOutputMessages.length > 0) {
    emitPhase(llmEndTime);
  }

  return phases;
}

function createChatSpan(
  llmEntry: LlmSpanEntry,
  phase: ChatPhase,
  sessionAgentCtx: ReturnType<typeof trace.setSpan>,
  finishReason: string | undefined,
  responseId: string | undefined,
  phaseUsage: LlmOutputEvent['usage'] | undefined,
  fallbackUsage: LlmOutputEvent['usage'],
  isLastPhase: boolean,
  config: PromptLayerPluginConfig,
): void {
  const tracer = trace.getTracer(INSTRUMENTATION_SCOPE_NAME, '1.0.0');
  const spanName = `chat ${llmEntry.model || llmEntry.provider || 'unknown'}`;
  const conversationId = llmEntry.sessionKey || 'unknown';
  const attributes: Record<string, string | number | string[]> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.agent.name': llmEntry.agentName,
    'gen_ai.conversation.id': conversationId,
    'gen_ai.system': resolveGenAiSystemName(llmEntry.provider, llmEntry.model),
    'gen_ai.request.model': llmEntry.model,
    'gen_ai.provider.name': llmEntry.provider,
    'gen_ai.response.model': llmEntry.model,
    'session.id': conversationId,
    'openclaw.llm.run_id': llmEntry.runId,
  };

  if (config.captureMessageContent) {
    const inputMessagesForChatSpan =
      llmEntry.systemInstructions.length > 0
        ? stripLeadingSystemMessages(phase.inputMessages)
        : phase.inputMessages;
    if (inputMessagesForChatSpan.length > 0) {
      attributes['gen_ai.input.messages'] = prepareForCapture(
        inputMessagesForChatSpan,
        config.historyMessagesMaxLength,
        config.redactSecrets,
      );
    }
    if (llmEntry.systemInstructions.length > 0) {
      attributes['gen_ai.system_instructions'] = prepareForCapture(
        llmEntry.systemInstructions,
        config.toolInputMaxLength,
        config.redactSecrets,
      );
    }
    if (phase.outputMessages.length > 0) {
      attributes['gen_ai.output.messages'] = prepareForCapture(
        phase.outputMessages,
        config.toolOutputMaxLength,
        config.redactSecrets,
      );
    }
  }

  const phaseHasToolCall = countToolCalls(phase.outputMessages) > 0;
  const resolvedFinishReason = phaseHasToolCall
    ? 'tool_call'
    : finishReason && finishReason !== ''
      ? finishReason
      : undefined;
  if (resolvedFinishReason) {
    attributes['gen_ai.response.finish_reasons'] = [resolvedFinishReason];
  }
  if (!phaseHasToolCall && typeof responseId === 'string' && responseId !== '') {
    attributes['gen_ai.response.id'] = responseId;
  }
  const usageForPhase = phaseUsage ?? (isLastPhase ? fallbackUsage : undefined);
  if (usageForPhase) {
    if (usageForPhase.input !== undefined) {
      attributes['gen_ai.usage.input_tokens'] = usageForPhase.input;
    }
    if (usageForPhase.output !== undefined) {
      attributes['gen_ai.usage.output_tokens'] = usageForPhase.output;
    }
    if (usageForPhase.cacheRead !== undefined) {
      attributes['openclaw.usage.cache_read_tokens'] = usageForPhase.cacheRead;
    }
    if (usageForPhase.cacheWrite !== undefined) {
      attributes['openclaw.usage.cache_write_tokens'] = usageForPhase.cacheWrite;
    }
  }

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes,
      startTime: phase.startTime,
    },
    sessionAgentCtx,
  );
  span.setStatus({ code: SpanStatusCode.OK });
  span.end(phase.endTime);
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

  // 基于最终完整消息重建 chat 阶段 spans（而不是保留一个覆盖整轮的 chat span）
  if (llmEntry) {
    try {
      const completedToolsForRun = (session.completedToolCalls ?? [])
        .filter((toolCall) => toolCall.runId === llmEntry.runId)
        .sort((left, right) => left.startTime - right.startTime);
      const llmEndTime = Math.max(
        Date.now(),
        (completedToolsForRun.at(-1)?.endTime ?? llmEntry.startTime) +
          TOOL_GROUP_TAIL_MS +
          CHAT_TOOL_BOUNDARY_GAP_MS,
      );
      const deferredConversationMessages = buildMessagesFromConversationHistory(
        session.deferredAgentEnd?.event.messages,
      );
      const deferredConversationRawMessages = extractConversationOutputRawMessages(
        session.deferredAgentEnd?.event.messages,
        llmEntry.inputMessages,
      );
      const candidateOutputMessages =
        event.lastAssistant != null
          ? normalizeToGenAiOutputMessages(event.lastAssistant, event.finishReason)
          : [];
      const fallbackOutputMessages = buildAssistantMessagesFromTexts(
        event.assistantTexts,
        event.finishReason,
      );
      const conversationOutputMessages = extractConversationOutputMessages(
        deferredConversationMessages,
        llmEntry.inputMessages,
      );
      const outputMessages =
        conversationOutputMessages.length > 0
          ? conversationOutputMessages
          : hasVisibleAssistantText(candidateOutputMessages) || fallbackOutputMessages.length === 0
            ? candidateOutputMessages
            : fallbackOutputMessages;

      const phases = buildChatPhases(
        llmEntry.inputMessages,
        outputMessages,
        completedToolsForRun,
        llmEntry.startTime,
        llmEndTime,
      );
      const phaseUsages = buildPhaseUsages(deferredConversationRawMessages);

      const toolGroup =
        typeof llmEntry.runId === 'string' && llmEntry.runId !== ''
          ? spanStore.deleteToolGroup(sessionKey, llmEntry.runId)
          : undefined;
      if (toolGroup) {
        toolGroup.span.setAttribute('tools', toolGroup.toolNames);
        toolGroup.span.setStatus({ code: SpanStatusCode.OK });
        toolGroup.span.end(
          Math.max(
            toolGroup.startTime + CHAT_TOOL_BOUNDARY_GAP_MS,
            toolGroup.endTime ?? (completedToolsForRun.at(-1)?.endTime ?? llmEndTime),
          ),
        );
      }

      phases.forEach((phase, index) => {
        createChatSpan(
          llmEntry,
          phase,
          session.agentCtx,
          event.finishReason,
          event.responseId,
          phaseUsages.length === phases.length ? phaseUsages[index] : undefined,
          usage,
          index === phases.length - 1,
          config,
        );
      });

      session.latestAllMessages =
        deferredConversationMessages.length > 0
          ? deferredConversationMessages
          : buildPydanticAiAllMessages(llmEntry.inputMessages, outputMessages);
      session.latestSystemInstructions = llmEntry.systemInstructions;
      const finalResult = extractFinalResult(session.latestAllMessages);
      if (finalResult) {
        session.agentSpan.setAttribute('gen_ai.output.text', finalResult);
      }
    } finally {
      maybeFinalizeDeferredAgentEnd(sessionKey);
    }
  }
}
