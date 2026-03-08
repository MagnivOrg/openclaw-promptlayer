// SPDX-License-Identifier: MIT
/**
 * Hook: agent_end
 *
 * Closes the invoke_agent span, records token usage and duration,
 * emits metrics, and logs the Logfire trace link.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { buildLogfireTraceUrl } from '../trace-link.js';
import { recordOperationDuration } from '../metrics/genai-metrics.js';
import {
  extractWorkspaceName,
  extractErrorDetails,
  buildMessagesFromConversationHistory,
  extractFinalResult,
  LOGFIRE_JSON_SCHEMA_KEY,
  PYDANTIC_AI_AGENT_ATTRIBUTES_SCHEMA_STRING,
} from '../util.js';
import type { LogfirePluginConfig } from '../config.js';
import type { AgentContext } from './before-agent-start.js';

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

function finalizeAgentEndNow(
  event: AgentEndEvent,
  ctx: AgentContext,
  config: LogfirePluginConfig,
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
  const durationS = durationMs / 1000;
  const agentName =
    typeof ctx.agentId === 'string' && ctx.agentId.length > 0
      ? ctx.agentId
      : 'agent';
  const workspace = extractWorkspaceName(
    typeof ctx.workspaceDir === 'string' ? ctx.workspaceDir : undefined,
  );

  // Close any remaining tool spans (shouldn't happen but safety net)
  // Reverse order: close children before parent (LIFO)
  for (let i = session.toolStack.length - 1; i >= 0; i--) {
    session.toolStack[i].span.end();
  }
  for (const toolGroup of session.activeToolGroups.values()) {
    toolGroup.span.end(toolGroup.endTime);
  }

  // Close any pending LLM spans (aborted mid-call)
  session.llmSpans.clear();

  // Duration and tool count
  session.agentSpan.setAttribute('openclaw.request.duration_ms', durationMs);
  session.agentSpan.setAttribute(
    'openclaw.request.tool_count',
    session.toolSequence,
  );

  // Cumulative token usage from llm_output hooks
  const { tokens } = session;
  if (tokens.input > 0 || tokens.output > 0) {
    session.agentSpan.setAttribute('gen_ai.usage.input_tokens', tokens.input);
    session.agentSpan.setAttribute('gen_ai.usage.output_tokens', tokens.output);
    if (tokens.cacheRead > 0) {
      session.agentSpan.setAttribute('openclaw.usage.cache_read_tokens', tokens.cacheRead);
    }
    if (tokens.cacheWrite > 0) {
      session.agentSpan.setAttribute('openclaw.usage.cache_write_tokens', tokens.cacheWrite);
    }
  }

  // Model/provider from LLM hooks (last seen values)
  if (session.model) {
    session.agentSpan.setAttribute('gen_ai.request.model', session.model);
    session.agentSpan.setAttribute('gen_ai.response.model', session.model);
    session.agentSpan.setAttribute('model_name', session.model);
  }
  if (session.provider) {
    session.agentSpan.setAttribute('gen_ai.provider.name', session.provider);
  }

  const fullConversationMessages = buildMessagesFromConversationHistory(event.messages);
  if (fullConversationMessages.length > 0) {
    session.latestAllMessages = fullConversationMessages;
  }

  if (session.latestAllMessages && session.latestAllMessages.length > 0) {
    session.agentSpan.setAttribute(
      'pydantic_ai.all_messages',
      JSON.stringify(session.latestAllMessages),
    );
    session.agentSpan.setAttribute(
      LOGFIRE_JSON_SCHEMA_KEY,
      PYDANTIC_AI_AGENT_ATTRIBUTES_SCHEMA_STRING,
    );
    const finalResult = extractFinalResult(session.latestAllMessages);
    if (finalResult) {
      session.agentSpan.setAttribute('final_result', finalResult);
    }
  }
  if (session.latestSystemInstructions && session.latestSystemInstructions.length > 0) {
    session.agentSpan.setAttribute(
      'gen_ai.system_instructions',
      JSON.stringify(session.latestSystemInstructions),
    );
    session.agentSpan.setAttribute(
      LOGFIRE_JSON_SCHEMA_KEY,
      PYDANTIC_AI_AGENT_ATTRIBUTES_SCHEMA_STRING,
    );
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

    // 出错时打出模型与输入摘要，便于排查 LLM timeout 等
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

  // End the agent span
  session.agentSpan.end();

  // Record metrics
  if (config.enableMetrics) {
    const metricAttrs = {
      agentName,
      workspace,
      providerName: session.provider || config.providerName || 'unknown',
      requestModel: session.model || '',
      responseModel: session.model || '',
      hasError: !!(event.error || !event.success || session.hasError),
      errorType: event.error
        ? 'AgentError'
        : undefined,
    };

    recordOperationDuration(durationS, metricAttrs);
  }

  // Log trace link
  if (config.enableTraceLinks && config.projectUrl) {
    const traceId = session.agentSpan.spanContext().traceId;
    const url = buildLogfireTraceUrl(config.projectUrl, traceId);
    logger.info(`Logfire trace: ${url}`);
  }

  // Cleanup
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
  config: LogfirePluginConfig,
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

  // 主路径：真的等到最后一个 llm_output 收尾后再结束 agent span。
  // 仅当 llm_output 丢失时，watchdog 才兜底强制收尾，避免悬挂 session。
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
