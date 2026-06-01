// SPDX-License-Identifier: MIT
/**
 * In-memory store mapping OpenClaw session keys to active OTEL spans.
 *
 * Tool spans use a stack (LIFO) so nested tool calls close in the
 * correct order.  A TTL-based cleanup prevents memory leaks from
 * sessions that never fire agent_end (e.g. gateway crash).
 */

import type { Span, Context } from '@opentelemetry/api';
import type { PromptLayerPluginConfig } from '../config.js';
import type { Logger, AgentEndEvent } from '../hooks/agent-end.js';
import type { AgentContext } from '../hooks/before-agent-start.js';
import type { GenAiChatMessage, GenAiToolDefinition, SystemInstructionPart } from '../util.js';

export interface ToolSpanEntry {
  span: Span;
  ctx: Context;
  name: string;
  callId: string;
  runId?: string;
  params?: Record<string, unknown>;
  startTime: number;
}

export interface LlmSpanEntry {
  runId: string;
  sessionKey: string;
  agentName: string;
  provider: string;
  model: string;
  startTime: number;
  /** Base request messages for the current LLM call. */
  inputMessages: GenAiChatMessage[];
  /** System instructions shared by the chat span and session summary. */
  systemInstructions: SystemInstructionPart[];
  /** Tool definitions available to this LLM call. */
  toolDefinitions?: GenAiToolDefinition[];
  /** Output observed by llm_output; emitted at agent_end to avoid whole-turn pairing. */
  outputMessages?: GenAiChatMessage[];
  finishReason?: string;
  responseId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  endTime?: number;
}

export interface CompletedToolCall {
  runId?: string;
  name: string;
  callId: string;
  startTime: number;
  endTime: number;
  params?: Record<string, unknown>;
  result?: unknown;
}

export interface TokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionSpanContext {
  /** Root span: invoke_agent */
  agentSpan: Span;
  agentCtx: Context;

  /** Tool call stack (LIFO for correct nesting) */
  toolStack: ToolSpanEntry[];

  /** Pending LLM call spans indexed by runId */
  llmSpans: Map<string, LlmSpanEntry>;

  /** Completed LLM hook payloads waiting to be reconciled at agent_end. */
  completedLlmCalls: LlmSpanEntry[];

  /** Completed tool calls used when reconstructing later chat spans. */
  completedToolCalls: CompletedToolCall[];

  /** Accumulated token usage across all LLM calls */
  tokens: TokenAccumulator;

  /** Last known model (set by llm_input/llm_output hooks) */
  model?: string;

  /** Last known provider (set by llm_input/llm_output hooks) */
  provider?: string;

  /** Last LLM runId, used to correlate agent error logs. */
  lastLlmRunId?: string;

  /** Last LLM input preview, used in agent error logs. */
  lastLlmPrompt?: string;

  /** Latest full message set for the current session. */
  latestAllMessages?: GenAiChatMessage[];

  /** Latest system instructions for the current session. */
  latestSystemInstructions?: SystemInstructionPart[];

  /** Last emitted chat span end time, used to sequence reconstructed final calls. */
  lastChatEndTime?: number;

  /** Whether the last emitted chat span contained final assistant text. */
  lastChatHadTextOutput?: boolean;

  /** Whether the last emitted chat span requested tool execution. */
  lastChatHadToolCall?: boolean;

  /** History captured at agent start for llm_input fallback. */
  initialHistoryMessages?: GenAiChatMessage[];

  /** Monotonic tool call counter for sequencing */
  toolSequence: number;

  /** Whether any tool errored (propagated to agent span) */
  hasError: boolean;

  /** Request start timestamp */
  startTime: number;

  /** Deferred agent_end data while waiting for pending llm_output events. */
  deferredAgentEnd?: {
    event: AgentEndEvent;
    ctx: AgentContext;
    config: PromptLayerPluginConfig;
    logger: Logger;
    requestedAt: number;
  };
}

/** Max age before a session is considered orphaned and cleaned up. */
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

class SpanStore {
  private sessions = new Map<string, SessionSpanContext>();

  set(sessionKey: string, ctx: SessionSpanContext): void {
    this.sessions.set(sessionKey, ctx);
    this.cleanup();
  }

  get(sessionKey: string): SessionSpanContext | undefined {
    return this.sessions.get(sessionKey);
  }

  delete(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /** Push a tool span onto the session's stack. */
  pushTool(sessionKey: string, entry: ToolSpanEntry): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.toolStack.push(entry);
  }

  /** Pop the most recent tool span (LIFO). */
  popTool(sessionKey: string): ToolSpanEntry | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    return session.toolStack.pop();
  }

  /** Peek at the top of the tool stack without removing. */
  peekTool(sessionKey: string): ToolSpanEntry | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session || session.toolStack.length === 0) return undefined;
    return session.toolStack[session.toolStack.length - 1];
  }

  /** Store a pending LLM call span. */
  setLlmSpan(sessionKey: string, runId: string, entry: LlmSpanEntry): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.llmSpans.set(runId, entry);
  }

  /** Retrieve a pending LLM call span by runId. */
  getLlmSpan(sessionKey: string, runId: string): LlmSpanEntry | undefined {
    return this.sessions.get(sessionKey)?.llmSpans.get(runId);
  }

  /** Remove and return an LLM call span. */
  deleteLlmSpan(sessionKey: string, runId: string): LlmSpanEntry | undefined {
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;
    const entry = session.llmSpans.get(runId);
    if (entry) session.llmSpans.delete(runId);
    return entry;
  }

  addCompletedLlmCall(sessionKey: string, entry: LlmSpanEntry): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (!Array.isArray(session.completedLlmCalls)) {
      session.completedLlmCalls = [];
    }
    session.completedLlmCalls.push(entry);
  }

  /** Record a completed tool call for later chat span reconstruction. */
  addCompletedToolCall(sessionKey: string, entry: CompletedToolCall): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    if (!Array.isArray(session.completedToolCalls)) {
      session.completedToolCalls = [];
    }
    session.completedToolCalls.push(entry);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** End orphaned spans and remove stale sessions. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.startTime > MAX_AGE_MS) {
        // Close children before parent — reverse order (LIFO)
        for (let i = session.toolStack.length - 1; i >= 0; i--) {
          session.toolStack[i].span.end();
        }
        session.agentSpan.end();
        this.sessions.delete(key);
      }
    }
  }
}

export const spanStore = new SpanStore();
