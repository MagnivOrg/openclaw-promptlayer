// SPDX-License-Identifier: MIT
/**
 * Hook: before_tool_call
 *
 * Creates an `execute_tool` child span for each tool invocation,
 * following OTEL GenAI semantic conventions.
 */

import { trace, SpanKind } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  prepareForCapture,
  generateCallId,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import { getPromptLayerTracer } from '../otel.js';

const TOOL_SPAN_DURATION_FLOOR_MS = 1;

/** OpenClaw before_tool_call event payload. */
export interface BeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

/** OpenClaw tool call hook context (2nd argument). */
export interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
  runId?: string;
  toolCallId?: string;
}

export function handleBeforeToolCall(
  event: BeforeToolCallEvent,
  ctx: ToolContext,
  config: PromptLayerPluginConfig,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  const tracer = getPromptLayerTracer();
  const toolName =
    typeof ctx.toolName === 'string' && ctx.toolName.length > 0
      ? ctx.toolName
      : typeof event.toolName === 'string' && event.toolName.length > 0
        ? event.toolName
        : 'unknown';
  const callId =
    typeof ctx.toolCallId === 'string' && ctx.toolCallId !== ''
      ? ctx.toolCallId
      : typeof event.toolCallId === 'string' && event.toolCallId !== ''
        ? event.toolCallId
        : generateCallId();
  const relatedRunId =
    typeof ctx.runId === 'string' && ctx.runId !== ''
      ? ctx.runId
      : typeof event.runId === 'string'
        ? event.runId
        : undefined;
  const relatedLlmEntry =
    typeof relatedRunId === 'string' && relatedRunId !== ''
      ? spanStore.getLlmSpan(sessionKey, relatedRunId)
      : undefined;
  const lastCompletedToolEndTime = (session.completedToolCalls ?? []).at(-1)?.endTime ?? 0;
  const toolStartTime = Math.max(
    Date.now(),
    (relatedLlmEntry?.startTime ?? 0) + TOOL_SPAN_DURATION_FLOOR_MS,
    lastCompletedToolEndTime + TOOL_SPAN_DURATION_FLOOR_MS,
  );

  session.toolSequence++;

  const toolParentCtx = session.agentCtx;

  // Span name per spec: "execute_tool {gen_ai.tool.name}"
  const spanName = `execute_tool ${toolName}`;

  const attributes: Record<string, string | number | boolean> = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName,
    'gen_ai.tool.call.id': callId,
    'gen_ai.tool.type': 'function',
    'openclaw.tool.sequence': session.toolSequence,
  };

  // Opt-in: capture tool arguments
  if ((config.captureToolInput || config.captureMessageContent) && event.params !== undefined) {
    const serializedArguments = prepareForCapture(
      event.params,
      config.toolInputMaxLength,
      config.redactSecrets,
    );
    attributes['gen_ai.tool.call.arguments'] = serializedArguments;
  }

  const toolSpan = tracer.startSpan(
    spanName,
    { kind: SpanKind.INTERNAL, attributes, startTime: toolStartTime },
    toolParentCtx,
  );

  const toolCtx = trace.setSpan(session.agentCtx, toolSpan);

  spanStore.pushTool(sessionKey, {
    span: toolSpan,
    ctx: toolCtx,
    name: toolName,
    callId,
    runId: relatedRunId,
    params: event.params,
    startTime: toolStartTime,
  });
}
