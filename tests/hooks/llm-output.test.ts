import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../../src/context/span-store.js';
import { mockSpan, mockContext, createTestConfig, createMockLogger } from '../test-helpers.js';
import { handleLlmOutput } from '../../src/hooks/llm-output.js';
import type { LlmOutputEvent } from '../../src/hooks/llm-output.js';
import type { LlmContext } from '../../src/hooks/llm-input.js';
import { handleAgentEnd } from '../../src/hooks/agent-end.js';

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
    parent: unknown;
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
      startSpan: vi.fn((name: string, options: Record<string, unknown>, parent: unknown) => {
        const span = createSpan();
        spanRecords.push({ name, options, parent, span });
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

vi.mock('../../src/otel.js', () => ({
  getPromptLayerTracer: vi.fn(() => mockTracerInstance),
}));

function seedSessionWithLlm(sessionKey: string, runId: string) {
  const agentSpan = mockSpan();
  const agentCtx = mockContext();

  spanStore.set(sessionKey, {
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

  return { agentSpan, agentCtx };
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

  function parseMessageAttr(value: unknown) {
    expect(typeof value).toBe('string');
    return JSON.parse(value as string) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
      finish_reason?: string;
    }>;
  }

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
      createTestConfig(),
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

  it('writes thinking output separately from final content', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'inspect the input first' },
            { type: 'text', text: '<final>Final answer</final>' },
          ],
        },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    const outputMessages = parseMessageAttr(spanAttributes['gen_ai.output.messages']);
    expect(outputMessages[0].parts).toEqual([
      { type: 'thinking', content: 'inspect the input first' },
      { type: 'text', content: 'Final answer' },
    ]);
  });

  it('writes OpenAI reasoning summaries as thinking output', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        provider: 'openai',
        model: 'gpt-5.5',
        lastAssistant: {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'I should compute directly.' }],
            },
            { type: 'output_text', text: '19 times 23 is 437.' },
          ],
        },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    const outputMessages = parseMessageAttr(spanAttributes['gen_ai.output.messages']);
    expect(outputMessages[0].parts).toEqual([
      { type: 'thinking', content: 'I should compute directly.' },
      { type: 'text', content: '19 times 23 is 437.' },
    ]);
  });

  it('writes gen_ai.tool.definitions onto the reconstructed chat span', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const llmEntry = spanStore.getLlmSpan('sess-1', 'run-1');
    if (!llmEntry) throw new Error('expected llm entry');
    llmEntry.toolDefinitions = [
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ];

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'Hi there' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.tool.definitions']).toContain('"name":"read"');
    expect(spanAttributes['gen_ai.tool.definitions']).toContain('"parameters"');
  });

  it('falls back to assistantTexts when lastAssistant is missing', () => {
    seedSessionWithLlm('sess-1', 'run-1');

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: undefined,
        assistantTexts: ['first segment', 'second segment'],
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.output.messages']).toContain('first segment');
    expect(spanStore.get('sess-1')?.latestAllMessages).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'first segment\nsecond segment' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('keeps a deferred final answer scoped to the current chat span', () => {
    const { agentCtx } = seedSessionWithLlm('sess-1', 'run-1');
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('expected session');
    session.deferredAgentEnd = {
      event: {
        success: true,
        messages: [
          { role: 'user', content: 'write the file' },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { file: '/tmp/a' } }],
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'write',
            content: [{ type: 'text', text: 'write succeeded' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '<final>done writing</final>' }],
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
        result: 'write succeeded',
      },
    ];
    spanStore.setLlmSpan('sess-1', 'run-1', {
      runId: 'run-1',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now() - 20,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'write the file' }] }],
      systemInstructions: [],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'last llm output' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    expect(createdSpans).toHaveLength(2);
    expect(createdSpans.map((span) => span.name)).toEqual([
      'chat claude-sonnet-4-5-20250929',
      'chat claude-sonnet-4-5-20250929',
    ]);
    expect(createdSpans.every((span) => span.parent === agentCtx)).toBe(true);

    const firstAttributes = createdSpans[0].options.attributes as Record<string, string | string[]>;
    expect(firstAttributes['gen_ai.operation.name']).toBe('chat');
    const firstOutputMessages = parseMessageAttr(firstAttributes['gen_ai.output.messages']);
    expect(firstOutputMessages[0].parts).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'write', arguments: { file: '/tmp/a' } },
    ]);
    expect(firstAttributes['gen_ai.response.finish_reasons']).toEqual(['tool_call']);

    const finalAttributes = createdSpans[1].options.attributes as Record<string, string | string[]>;
    expect(finalAttributes['gen_ai.operation.name']).toBe('chat');
    const finalInputMessages = parseMessageAttr(finalAttributes['gen_ai.input.messages']);
    const finalOutputMessages = parseMessageAttr(finalAttributes['gen_ai.output.messages']);
    expect(finalInputMessages.flatMap((message) => message.parts).map((part) => part.type)).toEqual([
      'text',
      'tool_call',
      'tool_call_response',
    ]);
    expect(finalInputMessages[0].parts[0].content).toBe('write the file');
    expect(finalOutputMessages[0].parts).toEqual([{ type: 'text', content: 'done writing' }]);
    expect(finalAttributes['gen_ai.output.messages']).toContain('done writing');
    expect(finalAttributes['gen_ai.output.messages']).not.toContain('last llm output');
    expect(finalAttributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('uses per-assistant transcript usage for reconstructed tool-turn chat spans', () => {
    seedSessionWithLlm('sess-1', 'run-1');
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('expected session');
    session.deferredAgentEnd = {
      event: {
        success: true,
        messages: [
          { role: 'user', content: 'read and summarize' },
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } }],
            usage: { input: 120, output: 30, cacheRead: 10 },
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'read succeeded' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '<final>summary done</final>' }],
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
        result: 'read succeeded',
      },
    ];
    spanStore.setLlmSpan('sess-1', 'run-1', {
      runId: 'run-1',
      sessionKey: 'sess-1',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now() - 20,
      inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'read and summarize' }] }],
      systemInstructions: [],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'summary done' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    expect(createdSpans).toHaveLength(2);
    const firstSpanAttributes = createdSpans[0].options.attributes as Record<string, number | string>;
    expect(firstSpanAttributes['gen_ai.usage.input_tokens']).toBe(120);
    expect(firstSpanAttributes['gen_ai.usage.output_tokens']).toBe(30);
    expect(firstSpanAttributes['openclaw.usage.cache_read_tokens']).toBe(10);
    const finalSpanAttributes = createdSpans[1].options.attributes as Record<string, number | string>;
    expect(finalSpanAttributes['gen_ai.usage.input_tokens']).toBe(80);
    expect(finalSpanAttributes['gen_ai.usage.output_tokens']).toBe(20);
    expect(finalSpanAttributes['openclaw.usage.cache_read_tokens']).toBe(5);
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
        { role: 'system', parts: [{ type: 'text', content: 'system instructions' }] },
        { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
      ],
      systemInstructions: [{ type: 'text', content: 'system instructions' }],
    });

    handleLlmOutput(
      {
        ...baseEvent,
        lastAssistant: { role: 'assistant', content: 'Hi there' },
        finishReason: 'stop',
      },
      baseCtx,
      createTestConfig(),
    );

    const spanAttributes = createdSpans[0].options.attributes as Record<string, string>;
    expect(spanAttributes['gen_ai.system_instructions']).toContain('system instructions');
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
      createTestConfig(),
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

  it('emits a best-effort chat span when llm_input metadata is missing', () => {
    const agentSpan = mockSpan();
    spanStore.set('sess-1', {
      agentSpan,
      agentCtx: mockContext(),
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
      initialHistoryMessages: [],
    });

    handleLlmOutput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.tokens.input).toBe(100);
    expect(session.tokens.output).toBe(50);
    expect(createdSpans).toHaveLength(1);
    const spanAttributes = createdSpans[0].options.attributes as Record<string, string | number>;
    expect(spanAttributes['openclaw.llm.run_id']).toBe('run-1');
    const outputMessages = parseMessageAttr(spanAttributes['gen_ai.output.messages']);
    expect(outputMessages[0].parts).toEqual([{ type: 'text', content: 'Hello!' }]);
    expect(spanAttributes['gen_ai.usage.input_tokens']).toBe(100);
    expect(spanAttributes['gen_ai.usage.output_tokens']).toBe(50);
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
