import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import {
  mockSpan,
  mockContext,
  createTestConfig,
  createMockLogger,
} from '../test-helpers.js';
import { handleAgentEnd } from './agent-end.js';
import type { AgentEndEvent } from './agent-end.js';
import type { AgentContext } from './before-agent-start.js';

function seedSession(
  sessionKey: string,
  overrides?: Partial<{
    hasError: boolean;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    model: string;
    provider: string;
    toolSequence: number;
  }>,
) {
  const agentSpan = mockSpan();

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx: mockContext(),
    toolStack: [],
    llmSpans: new Map(),
    completedToolCalls: [],
    activeToolGroups: new Map(),
    tokens: overrides?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: overrides?.toolSequence ?? 0,
    hasError: overrides?.hasError ?? false,
    startTime: Date.now() - 5000, // 5 seconds ago
    model: overrides?.model,
    provider: overrides?.provider,
    latestAllMessages: [],
    latestSystemInstructions: [],
    initialHistoryMessages: [],
  });

  return agentSpan;
}

describe('handleAgentEnd', () => {
  const logger = createMockLogger();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    spanStore.delete('sess-1');
  });

  const baseEvent: AgentEndEvent = {
    messages: [],
    success: true,
  };

  const baseCtx: AgentContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    workspaceDir: '/workspaces/marketing',
  };

  it('ends the agent span with OK status on success', () => {
    const agentSpan = seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(agentSpan.end).toHaveBeenCalled();
  });

  it('sets ERROR status when event.success is false', () => {
    const agentSpan = seedSession('sess-1');
    const event: AgentEndEvent = { messages: [], success: false };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ code: SpanStatusCode.ERROR }),
    );
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
  });

  it('sets AgentError when event.error is present', () => {
    const agentSpan = seedSession('sess-1');
    const event: AgentEndEvent = {
      messages: [],
      success: false,
      error: 'API rate limit exceeded',
    };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'AgentError');
    expect(agentSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'API rate limit exceeded',
    });
  });

  it('sets ToolError when session.hasError is true', () => {
    const agentSpan = seedSession('sess-1', { hasError: true });
    const event: AgentEndEvent = { messages: [], success: false };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('error.type', 'ToolError');
  });

  it('sets cumulative token attributes on agent span', () => {
    const agentSpan = seedSession('sess-1', {
      tokens: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 800 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 1000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 500);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_read_tokens', 2000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.usage.cache_write_tokens', 800);
  });

  it('omits token attributes when tokens are zero', () => {
    const agentSpan = seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasInputTokens = calls.some((call) => call[0] === 'gen_ai.usage.input_tokens');
    expect(hasInputTokens).toBe(false);
  });

  it('omits cache token attributes when cache tokens are zero', () => {
    const agentSpan = seedSession('sess-1', {
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasCacheRead = calls.some((call) => call[0] === 'openclaw.usage.cache_read_tokens');
    expect(hasCacheRead).toBe(false);
  });

  it('sets model and provider from session on agent span', () => {
    const agentSpan = seedSession('sess-1', {
      model: 'claude-sonnet-4-5-20250929',
      provider: 'anthropic',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-sonnet-4-5-20250929');
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', 'claude-sonnet-4-5-20250929');
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
  });

  it('writes final output and system instructions on root span', () => {
    const agentSpan = seedSession('sess-1', {
      model: 'claude-sonnet-4-5-20250929',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('session should exist');
    session.latestAllMessages = [
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'thinking', content: 'step 1' },
          { type: 'text', content: 'Final answer' },
        ],
        finish_reason: 'stop',
      },
    ];
    session.latestSystemInstructions = [{ type: 'text', content: 'System prompt' }];

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.output.text',
      'Final answer',
    );
    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.system_instructions',
      expect.stringContaining('"System prompt"'),
    );
  });

  it('extracts final output from agent_end messages when session cache is stale', () => {
    const agentSpan = seedSession('sess-1');
    const event: AgentEndEvent = {
      success: true,
      messages: [
        { role: 'user', content: '请帮我写入' },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { file: '/tmp/a' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'write',
          content: [{ type: 'text', text: '写入成功' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '<final>已经写好啦</final>' }],
        },
      ],
    };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('gen_ai.output.text', '已经写好啦');
  });

  it('sets duration and tool count attributes', () => {
    const agentSpan = seedSession('sess-1', { toolSequence: 5 });
    const event: AgentEndEvent = { messages: [], success: true, durationMs: 3000 };

    handleAgentEnd(event, baseCtx, createTestConfig(), logger);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.request.duration_ms', 3000);
    expect(agentSpan.setAttribute).toHaveBeenCalledWith('openclaw.request.tool_count', 5);
  });

  it('closes remaining tool spans on the stack', () => {
    const agentSpan = seedSession('sess-1');
    const orphanedToolSpan = mockSpan();
    spanStore.pushTool('sess-1', {
      span: orphanedToolSpan,
      ctx: mockContext(),
      name: 'Read',
      callId: 'c1',
      startTime: Date.now(),
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(orphanedToolSpan.end).toHaveBeenCalled();
  });

  it('keeps agent open until watchdog when LLM spans still pending', () => {
    seedSession('sess-1');
    spanStore.setLlmSpan('sess-1', 'run-orphan', {
      runId: 'run-orphan',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now(),
      inputMessages: [],
      systemInstructions: [],
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(spanStore.get('sess-1')?.deferredAgentEnd).toBeDefined();
    vi.runAllTimers();
    expect(spanStore.get('sess-1')).toBeUndefined();
  });

  it('defers finalization until pending llm_output is cleared', () => {
    const agentSpan = seedSession('sess-1');
    spanStore.setLlmSpan('sess-1', 'run-pending', {
      runId: 'run-pending',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'google',
      model: 'gemini-3.1-flash-lite-preview',
      startTime: Date.now(),
      inputMessages: [],
      systemInstructions: [],
    });

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(agentSpan.end).not.toHaveBeenCalled();

    spanStore.deleteLlmSpan('sess-1', 'run-pending');
    vi.runAllTimers();

    expect(agentSpan.end).toHaveBeenCalled();
  });

  it('deletes the session from span store', () => {
    seedSession('sess-1');

    handleAgentEnd(baseEvent, baseCtx, createTestConfig(), logger);

    expect(spanStore.get('sess-1')).toBeUndefined();
  });

  it('falls back to sessionId when sessionKey is missing', () => {
    seedSession('sess-1');
    const ctx: AgentContext = { agentId: 'my-agent', sessionId: 'sess-1' };

    handleAgentEnd(baseEvent, ctx, createTestConfig(), logger);

    expect(spanStore.get('sess-1')).toBeUndefined(); // cleaned up
  });

  it('returns early when no session key exists', () => {
    handleAgentEnd(baseEvent, {}, createTestConfig(), logger);
    // No error
  });
});
