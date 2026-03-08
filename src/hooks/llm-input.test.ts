import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleLlmInput } from './llm-input.js';
import type { LlmInputEvent, LlmContext } from './llm-input.js';

const { mockTracerInstance } = vi.hoisted(() => {
  return {
    mockTracerInstance: { startSpan: vi.fn() },
  };
});

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      getTracer: vi.fn(() => mockTracerInstance),
    },
  };
});

function seedSession(sessionKey: string) {
  const agentSpan = mockSpan();
  spanStore.set(sessionKey, {
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
  return agentSpan;
}

describe('handleLlmInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    spanStore.delete('sess-1');
  });

  const baseEvent: LlmInputEvent = {
    runId: 'run-abc',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    prompt: 'Hello',
    historyMessages: [],
    imagesCount: 0,
  };

  const baseCtx: LlmContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
  };

  it('stores phase reconstruction metadata instead of creating a chat span immediately', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
    expect(spanStore.getLlmSpan('sess-1', 'run-abc')).toMatchObject({
      runId: 'run-abc',
      agentName: 'my-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  it('stores the LLM metadata in the session', () => {
    seedSession('sess-1');

    handleLlmInput(
      { ...baseEvent, systemPrompt: 'You are helpful' },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    const llmEntry = spanStore.getLlmSpan('sess-1', 'run-abc');
    expect(llmEntry).toBeDefined();
    expect(llmEntry!.runId).toBe('run-abc');
    expect(llmEntry!.agentName).toBe('my-agent');
    expect(llmEntry!.provider).toBe('anthropic');
    expect(llmEntry!.model).toBe('claude-sonnet-4-5-20250929');
    expect(llmEntry!.inputMessages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
    expect(llmEntry!.systemInstructions).toEqual([
      { type: 'text', content: 'You are helpful' },
    ]);
  });

  it('updates session model and provider', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.model).toBe('claude-sonnet-4-5-20250929');
    expect(session.provider).toBe('anthropic');
  });

  it('updates agent span provider when config providerName is empty', () => {
    const agentSpan = seedSession('sess-1');
    const config = createTestConfig({ providerName: '' });

    handleLlmInput(baseEvent, baseCtx, config);

    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.provider.name',
      'anthropic',
    );
  });

  it('does NOT update agent span provider when config has explicit providerName', () => {
    const agentSpan = seedSession('sess-1');
    const config = createTestConfig({ providerName: 'custom-provider' });

    handleLlmInput(baseEvent, baseCtx, config);

    expect(agentSpan.setAttribute).not.toHaveBeenCalledWith(
      'gen_ai.provider.name',
      expect.anything(),
    );
  });

  it('captures message content into stored phase metadata when enabled', () => {
    seedSession('sess-1');
    const config = createTestConfig({ captureMessageContent: true });
    const event = { ...baseEvent, systemPrompt: 'You are helpful' };

    handleLlmInput(event, baseCtx, config);

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')).toMatchObject({
      inputMessages: [
        { role: 'system', parts: [{ type: 'text', content: 'You are helpful' }] },
        { role: 'user', parts: [{ type: 'text', content: 'Hello' }] },
      ],
      systemInstructions: [{ type: 'text', content: 'You are helpful' }],
    });
  });

  it('stores the fully expanded input message list when content capture is enabled', () => {
    seedSession('sess-1');
    const config = createTestConfig({ captureMessageContent: true });
    const event = { ...baseEvent, systemPrompt: 'System', prompt: 'User turn' };

    handleLlmInput(event, baseCtx, config);

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')?.inputMessages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'System' }] },
      { role: 'user', parts: [{ type: 'text', content: 'User turn' }] },
    ]);
    expect(spanStore.get('sess-1')?.latestAllMessages).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'System' }] },
      { role: 'user', parts: [{ type: 'text', content: 'User turn' }] },
    ]);
  });

  it('does not create any transient chat span during llm_input', () => {
    seedSession('sess-1');
    const config = createTestConfig({ captureMessageContent: true });
    const event = { ...baseEvent, systemPrompt: 'System', prompt: 'User turn' };

    handleLlmInput(event, baseCtx, config);

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('falls back to initial session history when llm_input payload omits historyMessages', () => {
    seedSession('sess-1');
    const session = spanStore.get('sess-1');
    if (!session) throw new Error('expected session');
    session.initialHistoryMessages = [
      { role: 'user', parts: [{ type: 'text', content: '历史消息' }] },
    ];

    handleLlmInput(
      { ...baseEvent, historyMessages: undefined, prompt: '当前问题' },
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')?.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '历史消息' }] },
      { role: 'user', parts: [{ type: 'text', content: '当前问题' }] },
    ]);
  });

  it('does not capture message history by default', () => {
    seedSession('sess-1');

    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')?.inputMessages).toEqual([]);
  });

  it('falls back to sessionId when sessionKey is missing', () => {
    seedSession('sess-1');
    const ctx: LlmContext = { sessionId: 'sess-1' };

    handleLlmInput(baseEvent, ctx, createTestConfig());

    expect(spanStore.getLlmSpan('sess-1', 'run-abc')).toBeDefined();
  });

  it('returns early when no session key exists', () => {
    handleLlmInput(baseEvent, {}, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', () => {
    // Don't seed session
    handleLlmInput(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });
});
