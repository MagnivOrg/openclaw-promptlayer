import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig, createMockLogger } from '../test-helpers.js';
import { handleLlmOutput } from './llm-output.js';
import type { LlmOutputEvent } from './llm-output.js';
import type { LlmContext } from './llm-input.js';
import { handleAgentEnd } from './agent-end.js';

const { mockTracerInstance, createdSpans } = vi.hoisted(() => {
  interface MockTestSpan {
    end: ReturnType<typeof vi.fn>;
    spanContext: ReturnType<typeof vi.fn>;
    setAttribute: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    addEvent: ReturnType<typeof vi.fn>;
    addLink: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    isRecording: ReturnType<typeof vi.fn>;
    updateName: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
  }

  interface CreatedSpanRecord {
    name: string;
    options: Record<string, unknown>;
    span: MockTestSpan;
  }

  const spanRecords: CreatedSpanRecord[] = [];
  const createSpan = (): MockTestSpan => ({
    end: vi.fn(),
    spanContext: vi.fn(() => ({ traceId: 'abc', spanId: 'def', traceFlags: 1 })),
    setAttribute: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    addEvent: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    recordException: vi.fn().mockReturnThis(),
    isRecording: vi.fn(() => true),
    updateName: vi.fn().mockReturnThis(),
    setAttributes: vi.fn().mockReturnThis(),
  });
  return {
    createdSpans: spanRecords,
    mockTracerInstance: {
      startSpan: vi.fn((name: string, options: Record<string, unknown>) => {
        const span = createSpan();
        spanRecords.push({ name, options, span });
        return span;
      }),
    },
  };
});

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn(() => mockTracerInstance),
    },
  };
});

function seedSessionWithLlm(sessionKey: string, runId: string) {
  const agentSpan = mockSpan();
  const agentCtx = mockContext();

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx,
    toolStack: [],
    llmSpans: new Map(),
    completedToolCalls: [],
    activeToolGroups: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
    latestAllMessages: [],
    latestSystemInstructions: [],
    initialHistoryMessages: [],
  });

  spanStore.setLlmSpan(sessionKey, runId, {
    runId,
    sessionKey,
    agentName: 'my-agent',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    startTime: Date.now(),
    inputMessages: [],
    systemInstructions: [],
  });

  return { agentSpan };
}

describe('handleLlmOutput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    createdSpans.length = 0;
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    spanStore.delete('sess-1');
  });

  const baseEvent: LlmOutputEvent = {
    runId: 'run-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    assistantTexts: ['Hello!'],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 80,
    },
  };

  const baseCtx: LlmContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    workspaceDir: '/workspaces/marketing',
  };

  it('accumulates tokens on the session', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(50);
    expect(session.tokens.cacheRead).toBe(200);
    expect(session.tokens.cacheWrite).toBe(80);
  });

  it('accumulates across multiple LLM calls', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    spanStore.setLlmSpan('sess-1', 'run-2', {
      runId: 'run-2',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now(),
      inputMessages: [],
      systemInstructions: [],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        runId: 'run-2',
        usage: { input: 50, output: 25 },
      },
      baseCtx,
      createTestConfig(),
    );

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(150);
    expect(session.tokens.output).toBe(75);
  });

  it('creates and ends a synthetic chat span with usage attributes', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).toHaveBeenCalledTimes(1);
    expect(createdSpans[0].name).toBe('chat claude-sonnet-4-5-20250929');
    expect(createdSpans[0].options).toMatchObject({
      kind: expect.any(Number),
      attributes: expect.objectContaining({
        'gen_ai.operation.name': 'chat',
        'gen_ai.response.model': 'claude-sonnet-4-5-20250929',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        'openclaw.usage.cache_read_tokens': 200,
        'openclaw.usage.cache_write_tokens': 80,
      }),
    });
    expect(createdSpans[0].span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(createdSpans[0].span.end).toHaveBeenCalled();
  });

  it('removes the LLM metadata from the store after reconstruction', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(spanStore.getLlmSpan('sess-1', 'run-1')).toBeUndefined();
  });

  it('writes gen_ai.output.messages onto the reconstructed chat span', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'Hi there' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.output.messages']).toContain('"type":"text"');
    expect(spanAttributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(spanStore.get('sess-1')?.latestAllMessages).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Hi there' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('falls back to assistantTexts when lastAssistant is missing', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: undefined,
        assistantTexts: ['第一段', '第二段'],
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.output.messages']).toContain('第一段');
    expect(spanStore.get('sess-1')?.latestAllMessages).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '第一段\n第二段' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('rebuilds chat into multiple phases when deferred messages contain tool usage', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('expected session');
    session.deferredAgentEnd = {
      event: {
        success: true,
        messages: [
          { role: 'user', content: '请写文件' },
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
      },
      ctx: { agentId: 'my-agent', sessionKey: 'sess-1', workspaceDir: '/workspaces/marketing' },
      config: createTestConfig(),
      logger: createMockLogger(),
      requestedAt: Date.now(),
    };
    session.completedToolCalls = [
      {
        runId: 'run-1',
        name: 'write',
        callId: 'call-1',
        startTime: Date.now(),
        endTime: Date.now() + 20,
        params: { file: '/tmp/a' },
        result: '写入成功',
      },
    ];
    spanStore.setLlmSpan('sess-1', 'run-1', {
      runId: 'run-1',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now() - 20,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: '请写文件' }] }],
      systemInstructions: [],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: '最后一条' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    expect(createdSpans).toHaveLength(2);
    const firstPhaseAttributes = createdSpans[0].options.attributes as Record<string, string | string[]>;
    const secondPhaseAttributes = createdSpans[1].options.attributes as Record<string, string | string[]>;
    expect(firstPhaseAttributes['gen_ai.output.messages']).toContain('"tool_call"');
    expect(firstPhaseAttributes['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(secondPhaseAttributes['gen_ai.input.messages']).toContain('"tool_call_response"');
    expect(secondPhaseAttributes['gen_ai.output.messages']).toContain('已经写好啦');
  });

  it('assigns per-phase usage from deferred assistant messages', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('expected session');
    session.deferredAgentEnd = {
      event: {
        success: true,
        messages: [
          { role: 'user', content: '请读取并总结' },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } }],
            usage: { input: 120, output: 30, cacheRead: 10 },
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: '读取成功' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '<final>总结完成</final>' }],
            usage: { input: 80, output: 20, cacheRead: 5 },
          },
        ],
      },
      ctx: { agentId: 'my-agent', sessionKey: 'sess-1', workspaceDir: '/workspaces/marketing' },
      config: createTestConfig(),
      logger: createMockLogger(),
      requestedAt: Date.now(),
    };
    session.completedToolCalls = [
      {
        runId: 'run-1',
        name: 'read',
        callId: 'call-1',
        startTime: Date.now(),
        endTime: Date.now() + 20,
        params: { path: '/tmp/a' },
        result: '读取成功',
      },
    ];
    spanStore.setLlmSpan('sess-1', 'run-1', {
      runId: 'run-1',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now() - 20,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: '请读取并总结' }] }],
      systemInstructions: [],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: '总结完成' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    expect(createdSpans).toHaveLength(2);
    const firstPhaseAttributes = createdSpans[0].options.attributes as Record<string, number | string[]>;
    const secondPhaseAttributes = createdSpans[1].options.attributes as Record<string, number | string[]>;
    expect(firstPhaseAttributes['gen_ai.usage.input_tokens']).toBe(120);
    expect(firstPhaseAttributes['gen_ai.usage.output_tokens']).toBe(30);
    expect(firstPhaseAttributes['openclaw.usage.cache_read_tokens']).toBe(10);
    expect(secondPhaseAttributes['gen_ai.usage.input_tokens']).toBe(80);
    expect(secondPhaseAttributes['gen_ai.usage.output_tokens']).toBe(20);
    expect(secondPhaseAttributes['openclaw.usage.cache_read_tokens']).toBe(5);
  });

  it('omits duplicated system messages from child chat input when system instructions exist', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    spanStore.setLlmSpan('sess-1', 'run-1', {
      runId: 'run-1',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now() - 20,
      inputMessages: [
        { role: 'system', parts: [{ type: 'text', content: '系统提示词' }] },
        { role: 'user', parts: [{ type: 'text', content: '你好' }] },
      ],
      systemInstructions: [{ type: 'text', content: '系统提示词' }],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'Hi there' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.system_instructions']).toContain('系统提示词');
    expect(spanAttributes['gen_ai.input.messages']).not.toContain('"role":"system"');
    expect(spanAttributes['gen_ai.input.messages']).toContain('"role":"user"');
  });

  it('does not set legacy events attribute', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'Hi there' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, unknown>;
    expect(spanAttributes.events).toBeUndefined();
  });

  it('handles missing usage gracefully', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput({ ...baseEvent, usage: undefined }, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(0);
    expect(session.tokens.output).toBe(0);
  });

  it('handles partial usage (only input tokens)', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        usage: { input: 100 },
      },
      baseCtx,
      createTestConfig(),
    );

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(0);
  });

  it('updates session model/provider to latest', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        provider: 'openai',
        model: 'gpt-4o',
      },
      baseCtx,
      createTestConfig(),
    );

    const session = spanStore.get('sess-1')!;
    expect(session.model).toBe('gpt-4o');
    expect(session.provider).toBe('openai');
  });

  it('returns early when no session key exists', () => {
    handleLlmOutput(baseEvent, {}, createTestConfig());

    expect(createdSpans).toHaveLength(0);
  });

  it('handles missing LLM metadata gracefully while still accumulating tokens', () => {
    const agentSpan = mockSpan();
    spanStore.set('sess-1', {
      agentSpan,
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      completedToolCalls: [],
      activeToolGroups: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
      initialHistoryMessages: [],
    });

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(50);
    expect(createdSpans).toHaveLength(0);
  });

  it('finalizes deferred agent_end when the last llm_output arrives', () => {
    const { agentSpan } = seedSessionWithLlm('sess-1', 'run-1');
    const logger = createMockLogger();

    handleAgentEnd(
      { messages: [], success: true },
      { agentId: 'my-agent', sessionKey: 'sess-1', workspaceDir: '/workspaces/marketing' },
      createTestConfig(),
      logger,
    );

    expect(agentSpan.end).not.toHaveBeenCalled();
    expect(spanStore.get('sess-1')?.deferredAgentEnd).toBeDefined();

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    expect(agentSpan.end).toHaveBeenCalled();
    expect(spanStore.get('sess-1')).toBeUndefined();
  });
});
