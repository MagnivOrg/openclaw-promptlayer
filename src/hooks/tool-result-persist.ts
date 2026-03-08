// SPDX-License-Identifier: MIT
/**
 * Hook: tool_result_persist (synchronous)
 *
 * Closes the most recent tool span, records result size, duration,
 * and any errors with full stack traces per OTEL exception conventions.
 *
 * This hook is synchronous — it MUST NOT return a Promise.
 * Return undefined to leave the result unmodified.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  LOGFIRE_JSON_SCHEMA_KEY,
  TOOL_SPAN_ATTRIBUTES_SCHEMA_STRING,
  prepareForCapture,
  safeJsonStringify,
} from '../util.js';
import type { LogfirePluginConfig } from '../config.js';

const TOOL_SPAN_DURATION_FLOOR_MS = 1;
const TOOL_GROUP_TAIL_MS = 2;

function finalizeToolGroupSpan(sessionKey: string, runId: string, fallbackEndTime: number): void {
  const toolGroup = spanStore.deleteToolGroup(sessionKey, runId);
  if (!toolGroup) return;
  toolGroup.span.setAttribute('tools', toolGroup.toolNames);
  toolGroup.span.setAttribute(
    'logfire.msg',
    toolGroup.toolNames.length === 1
      ? 'running 1 tool'
      : `running ${toolGroup.toolNames.length} tools`,
  );
  toolGroup.span.setStatus({ code: SpanStatusCode.OK });
  toolGroup.span.end(
    Math.max(
      toolGroup.startTime + TOOL_SPAN_DURATION_FLOOR_MS,
      toolGroup.endTime ?? fallbackEndTime,
    ),
  );
}

/** OpenClaw tool_result_persist event payload. */
export interface ToolResultPersistEvent {
  toolName?: string;
  toolCallId?: string;
  message?: unknown;
  isSynthetic?: boolean;
}

/** OpenClaw tool result persist hook context (2nd argument). */
export interface ToolResultPersistContext {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
}

export function handleToolResultPersist(
  event: ToolResultPersistEvent,
  ctx: ToolResultPersistContext,
  config: LogfirePluginConfig,
): void {
  const sessionKey =
    typeof ctx.sessionKey === 'string' && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;
  const entry = spanStore.popTool(sessionKey);
  if (!entry) return;
  let toolEndTime = entry.startTime + TOOL_SPAN_DURATION_FLOOR_MS;

  try {
    toolEndTime = Math.max(Date.now(), entry.startTime + TOOL_SPAN_DURATION_FLOOR_MS);
    const durationMs = toolEndTime - entry.startTime;
    entry.span.setAttribute('openclaw.tool.duration_ms', durationMs);

    // Result size (from the persisted message)
    if (event.message !== undefined) {
      const resultStr =
        typeof event.message === 'string'
          ? event.message
          : safeJsonStringify(event.message);
      entry.span.setAttribute('openclaw.tool.output_size', resultStr.length);

      // Opt-in: capture tool output
      if (config.captureToolOutput || config.captureMessageContent) {
        const serializedResult = prepareForCapture(
          event.message,
          config.toolOutputMaxLength,
          config.redactSecrets,
        );
        entry.span.setAttribute(
          'gen_ai.tool.call.result',
          serializedResult,
        );
        entry.span.setAttribute('tool_response', serializedResult);
        entry.span.setAttribute(LOGFIRE_JSON_SCHEMA_KEY, TOOL_SPAN_ATTRIBUTES_SCHEMA_STRING);
      }
    }

    // Tool-level errors are not available in this hook's event payload.
    // Errors are captured at the agent level in agent_end via event.error/event.success.
    entry.span.setStatus({ code: SpanStatusCode.OK });
    spanStore.addCompletedToolCall(sessionKey, {
      runId: entry.runId,
      name: entry.name,
      callId: entry.callId,
      startTime: entry.startTime,
      endTime: toolEndTime,
      params: entry.params,
      result: event.message,
    });
    if (typeof entry.runId === 'string' && entry.runId !== '') {
      const toolGroup = spanStore.getToolGroup(sessionKey, entry.runId);
      if (toolGroup) {
        toolGroup.openToolCount = Math.max(0, toolGroup.openToolCount - 1);
        toolGroup.endTime = toolEndTime + TOOL_GROUP_TAIL_MS;
        if (toolGroup.openToolCount === 0) {
          // 纯按 hook 顺序收束：当前一批工具全部结束后，立刻关闭 group，
          // 下一个 before_tool_call 自然会开启新的一批，而不是跨 assistant 往返复用。
          finalizeToolGroupSpan(sessionKey, entry.runId, toolEndTime + TOOL_GROUP_TAIL_MS);
        }
      }
    }
  } finally {
    entry.span.end(toolEndTime);
  }
}
