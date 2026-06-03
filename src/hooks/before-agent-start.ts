// SPDX-License-Identifier: MIT
/**
 * Hook: before_prompt_build
 *
 * Creates the root `invoke_agent` span following OTEL GenAI semantic
 * conventions.  This span parents all tool call spans and is closed
 * in agent-end.ts.
 */

import { trace, context, SpanKind } from '@opentelemetry/api';
import { spanStore, type SessionSpanContext } from '../context/span-store.js';
import {
  extractWorkspaceName,
  normalizeToGenAiInputMessages,
} from '../util.js';
import type { PromptLayerPluginConfig } from '../config.js';
import { getPromptLayerTracer } from '../otel.js';

/** OpenClaw before_prompt_build event payload. */
export interface BeforePromptBuildEvent {
  prompt: string;
  messages?: unknown[];
}

/** OpenClaw agent lifecycle hook context (2nd argument). */
export interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export function handleBeforePromptBuild(
  event: BeforePromptBuildEvent,
  ctx: AgentContext,
  config: PromptLayerPluginConfig,
): void {
  const sessionKey = ctx.sessionKey ?? ctx.sessionId;
  if (!sessionKey) return;

  const existingSession = spanStore.get(sessionKey);
  if (existingSession) {
    if (
      (existingSession.initialHistoryMessages?.length ?? 0) === 0 &&
      Array.isArray(event.messages)
    ) {
      existingSession.initialHistoryMessages = normalizeToGenAiInputMessages(event.messages);
    }
    return;
  }

  const tracer = getPromptLayerTracer();
  const agentName = ctx.agentId || 'agent';
  const workspace = extractWorkspaceName(ctx.workspaceDir);

  // Span name per spec: "invoke_agent {gen_ai.agent.name}"
  const spanName = `invoke_agent ${agentName}`;

  const agentSpan = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        // Required GenAI attributes
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': config.providerName || 'unknown',

        // Agent attributes
        'gen_ai.agent.name': agentName,
        'gen_ai.agent.id': agentName,
        'gen_ai.conversation.id': sessionKey,
        'session.id': sessionKey,
        'openclaw.agent.name': agentName,
        'openclaw.session_key': sessionKey,
        'openclaw.workspace': workspace,
        'openclaw.channel': ctx.messageProvider || 'unknown',
      },
    },
    context.active(),
  );

  const agentCtx = trace.setSpan(context.active(), agentSpan);
  const session: SessionSpanContext = {
    agentSpan,
    agentCtx,
    toolStack: [],
    llmSpans: new Map(),
    completedLlmCalls: [],
    completedToolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
    latestAllMessages: [],
    latestSystemInstructions: [],
    initialHistoryMessages: Array.isArray(event.messages)
      ? normalizeToGenAiInputMessages(event.messages)
      : [],
  };

  spanStore.set(sessionKey, session);
}
