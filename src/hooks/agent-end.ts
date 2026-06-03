// SPDX-License-Identifier: MIT
/**
 * Hook: agent_end
 *
 * Closes the invoke_agent span and records final status, usage, and duration.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore, type LlmSpanEntry } from '../context/span-store.js';
import {
  buildMessagesFromConversationHistory,
  extractErrorDetails,
  normalizeToGenAiInputMessages,
  type GenAiChatMessage,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import type { AgentContext } from './before-agent-start.js';
import { createChatSpan } from './chat-span.js';

/** OpenClaw agent_end event payload. */
export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** Logger interface — matches OpenClaw plugin api.logger shape. */
export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LLM_OUTPUT_WATCHDOG_MS = 10_000;
const FINAL_CHAT_DURATION_FLOOR_MS = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasAssistantText(message: GenAiChatMessage | undefined): boolean {
  return (
    message?.role === 'assistant' &&
    message.parts.some(
      (part) =>
        part.type === 'text' &&
        typeof part.content === 'string' &&
        part.content.trim() !== '',
    )
  );
}

function unwrapConversationMessages(messages: unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of messages) {
    if (!isRecord(item)) continue;
    const rawMessage = isRecord(item.message) ? item.message : item;
    if (typeof rawMessage.role !== 'string') continue;
    out.push(rawMessage);
  }
  return out;
}

function rawMessageTimestamp(raw: Record<string, unknown> | undefined): number | undefined {
  if (!raw) return undefined;
  return finiteNumber(raw.timestamp);
}

function rawAssistantUsage(
  raw: Record<string, unknown> | undefined,
): LlmSpanEntry['usage'] | undefined {
  if (!raw || !isRecord(raw.usage)) return undefined;
  const usage = raw.usage;
  const out: NonNullable<LlmSpanEntry['usage']> = {};
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}

function rawFinishReason(raw: Record<string, unknown> | undefined): string | undefined {
  const stopReason = typeof raw?.stopReason === 'string' ? raw.stopReason : undefined;
  if (!stopReason) return undefined;
  if (stopReason === 'toolUse') return 'tool_call';
  return stopReason;
}

function findCurrentTurnStart(messages: GenAiChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return 0;
}

function emitTranscriptChatSpans(
  sessionKey: string,
  session: NonNullable<ReturnType<typeof spanStore.get>>,
  event: AgentEndEvent,
  ctx: AgentContext,
  config: PromptLayerPluginConfig,
): boolean {
  const rawMessages = unwrapConversationMessages(event.messages);
  const fullConversationMessages =
    rawMessages.length > 0
      ? normalizeToGenAiInputMessages(rawMessages, { toolResultRole: 'tool' })
      : buildMessagesFromConversationHistory(event.messages);
  if (fullConversationMessages.length === 0) return false;

  const currentTurnStart = findCurrentTurnStart(fullConversationMessages);
  const turnMessages = fullConversationMessages.slice(currentTurnStart);
  const rawTurnMessages = rawMessages.slice(currentTurnStart);
  let emitted = false;
  let previousEndTime = session.startTime;

  for (let index = 0; index < turnMessages.length; index += 1) {
    const message = turnMessages[index];
    const raw = rawTurnMessages[index];
    const messageTime = rawMessageTimestamp(raw);
    if (message?.role !== 'assistant') {
      if (messageTime !== undefined) {
        previousEndTime = Math.max(previousEndTime, messageTime);
      }
      continue;
    }

    const endTime = Math.max(
      messageTime ?? Date.now(),
      previousEndTime + FINAL_CHAT_DURATION_FLOOR_MS,
    );
    const startTime = Math.max(previousEndTime, endTime - FINAL_CHAT_DURATION_FLOOR_MS);
    const provider =
      typeof raw?.provider === 'string'
        ? raw.provider
        : session.provider ?? config.providerName ?? 'unknown';
    const model =
      typeof raw?.model === 'string'
        ? raw.model
        : session.model ?? 'unknown';
    const responseId = typeof raw?.responseId === 'string' ? raw.responseId : undefined;
    const llmEntry: LlmSpanEntry = {
      runId: `${session.lastLlmRunId ?? sessionKey}:message-${currentTurnStart + index}`,
      sessionKey,
      agentName: ctx.agentId || 'agent',
      provider,
      model,
      startTime,
      inputMessages: turnMessages.slice(0, index),
      systemInstructions: session.latestSystemInstructions ?? [],
    };

    createChatSpan(
      llmEntry,
      llmEntry.inputMessages,
      [message],
      session.agentCtx,
      message.finish_reason ?? rawFinishReason(raw) ?? (hasAssistantText(message) ? 'stop' : undefined),
      responseId,
      rawAssistantUsage(raw),
      endTime,
    );
    previousEndTime = endTime;
    emitted = true;
  }

  if (emitted) {
    session.latestAllMessages = fullConversationMessages;
  }
  return emitted;
}

function emitLlmOutputFallbackChatSpan(
  sessionKey: string,
  session: NonNullable<ReturnType<typeof spanStore.get>>,
): void {
  const completed = (session.completedLlmCalls ?? []).at(-1);
  if (!completed?.outputMessages || completed.outputMessages.length === 0) return;
  createChatSpan(
    completed,
    completed.inputMessages,
    completed.outputMessages,
    session.agentCtx,
    completed.finishReason,
    completed.responseId,
    completed.usage,
    completed.endTime ?? Date.now(),
  );
  session.latestAllMessages = [
    ...completed.inputMessages,
    ...completed.outputMessages,
  ];
  session.lastChatEndTime = completed.endTime;
  session.lastChatHadTextOutput = completed.outputMessages.some(hasAssistantText);
}

function finalizeAgentEndNow(
  event: AgentEndEvent,
  ctx: AgentContext,
  config: PromptLayerPluginConfig,
  logger: Logger,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0
        ? ctx.sessionId
        : undefined;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  const durationMs =
    typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? event.durationMs
      : Date.now() - session.startTime;
  // Close any remaining tool spans (shouldn't happen but safety net)
  // Reverse order: close children before parent (LIFO)
  for (let i = session.toolStack.length - 1; i >= 0; i--) {
    session.toolStack[i].span.end();
  }

  // Close any pending LLM spans (aborted mid-call)
  session.llmSpans.clear();

  // Duration and tool count
  session.agentSpan.setAttribute('openclaw.request.duration_ms', durationMs);
  session.agentSpan.setAttribute(
    'openclaw.request.tool_count',
    session.toolSequence,
  );

  if (!emitTranscriptChatSpans(sessionKey, session, event, ctx, config)) {
    emitLlmOutputFallbackChatSpan(sessionKey, session);
  }

  // Error status
  if (event.error || !event.success || session.hasError) {
    const errorType =
      event.error
        ? 'AgentError'
        : session.hasError
          ? 'ToolError'
          : 'Error';
    const errorMsg = event.error || 'Agent invocation failed';
    session.agentSpan.setAttribute('error.type', errorType);
    session.agentSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMsg,
    });

    // Include model and input context to make LLM timeouts easier to debug.
    const modelStr = session.model ?? 'unknown';
    const runIdStr = session.lastLlmRunId ?? '';
    const inputPreview = (session.lastLlmPrompt ?? '').replace(/\s+/g, ' ').trim();
    logger.error(
      `[agent/embedded] agent error context: model=${modelStr} runId=${runIdStr} inputPreview=${inputPreview || '(none)'}`,
    );

    // Record structured exception per OTEL semantic conventions.
    // recordException() expects Error | string — construct a real Error instance.
    const errDetails = extractErrorDetails(event.error ?? errorMsg);
    const exception = new Error(errDetails.message);
    exception.name = errDetails.type;
    if (errDetails.stacktrace) exception.stack = errDetails.stacktrace;
    session.agentSpan.recordException(exception);
  } else {
    session.agentSpan.setStatus({ code: SpanStatusCode.OK });
  }

  session.agentSpan.end();

  spanStore.delete(sessionKey);
}

export function maybeFinalizeDeferredAgentEnd(sessionKey: string): boolean {
  const session = spanStore.get(sessionKey);
  if (!session?.deferredAgentEnd) return false;
  if (session.llmSpans.size > 0) return false;

  const { event, ctx, config, logger } = session.deferredAgentEnd;
  session.deferredAgentEnd = undefined;
  finalizeAgentEndNow(event, ctx, config, logger);
  return true;
}

function forceFinalizeDeferredAgentEnd(sessionKey: string): boolean {
  const session = spanStore.get(sessionKey);
  if (!session?.deferredAgentEnd) return false;

  const { event, ctx, config, logger } = session.deferredAgentEnd;
  session.deferredAgentEnd = undefined;
  finalizeAgentEndNow(event, ctx, config, logger);
  return true;
}

export function handleAgentEnd(
  event: AgentEndEvent,
  ctx: AgentContext,
  config: PromptLayerPluginConfig,
  logger: Logger,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0
        ? ctx.sessionId
        : undefined;
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Prefer waiting for the final llm_output before closing the agent span.
  // The watchdog only forces finalization when llm_output never arrives.
  if (session.llmSpans.size > 0) {
    if (!session.deferredAgentEnd) {
      session.deferredAgentEnd = {
        event,
        ctx,
        config,
        logger,
        requestedAt: Date.now(),
      };
      setTimeout(() => {
        forceFinalizeDeferredAgentEnd(sessionKey);
      }, LLM_OUTPUT_WATCHDOG_MS);
    }
    return;
  }

  finalizeAgentEndNow(event, ctx, config, logger);
}
