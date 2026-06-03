import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanKind } from '@opentelemetry/api';
import { spanStore } from '../../src/context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleBeforeAgentStart } from '../../src/hooks/before-agent-start.js';
import type { BeforeAgentStartEvent, AgentContext } from '../../src/hooks/before-agent-start.js';

// Hoisted so they're available when vi.mock factory runs
const { mockAgentSpan, mockTracerInstance, mockSetSpan } = vi.hoisted(() => {
  const span = {
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
  };
  return {
    mockAgentSpan: span,
    mockTracerInstance: { startSpan: vi.fn(() => span) },
    mockSetSpan: vi.fn(() => ({})),
  };
});

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      getTracer: vi.fn(() => mockTracerInstance),
      setSpan: mockSetSpan,
    },
    context: {
      active: vi.fn(() => ({})),
    },
    SpanKind: actual.SpanKind,
  };
});

vi.mock('../../src/otel.js', () => ({
  getPromptLayerTracer: vi.fn(() => mockTracerInstance),
}));

describe('handleBeforeAgentStart', () => {
  const config = createTestConfig({ providerName: 'anthropic' });

  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('session-1');
    spanStore.delete('session-2');
  });

  afterEach(() => {
    spanStore.delete('session-1');
    spanStore.delete('session-2');
  });

  const baseEvent: BeforeAgentStartEvent = {
    prompt: 'Hello agent',
  };

  it('creates a session in the span store', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionKey: 'session-1',
      workspaceDir: '/workspaces/marketing',
    };

    handleBeforeAgentStart(baseEvent, ctx, config);

    const session = spanStore.get('session-1');
    expect(session).toBeDefined();
    expect(session!.agentSpan).toBe(mockAgentSpan);
    expect(session!.toolStack).toEqual([]);
    expect(session!.toolSequence).toBe(0);
    expect(session!.hasError).toBe(false);
    expect(session!.llmSpans).toBeInstanceOf(Map);
    expect(session!.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('stores initial history messages from before_agent_start', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionKey: 'session-1',
    };

    handleBeforeAgentStart(
      {
        ...baseEvent,
        messages: [
          { role: 'user', content: 'previous question' },
          { role: 'assistant', content: 'previous answer' },
        ],
      },
      ctx,
      config,
    );

    expect(spanStore.get('session-1')?.initialHistoryMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'previous question' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'previous answer' }] },
    ]);
  });

  it('creates a span with correct name and attributes', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionKey: 'session-1',
      workspaceDir: '/workspaces/marketing',
      messageProvider: 'slack',
    };

    handleBeforeAgentStart(baseEvent, ctx, config);

    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      'invoke_agent my-agent',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.provider.name': 'anthropic',
          'gen_ai.agent.name': 'my-agent',
          'gen_ai.agent.id': 'my-agent',
          'gen_ai.conversation.id': 'session-1',
          'openclaw.session_key': 'session-1',
          'openclaw.workspace': 'marketing',
          'openclaw.channel': 'slack',
        }),
      }),
      expect.anything(), // parent context
    );
    expect(mockTracerInstance.startSpan).toHaveBeenCalledTimes(1);
    expect(
      (mockTracerInstance.startSpan.mock.calls as unknown as Array<[string]>).some(([name]) =>
        String(name).startsWith('agent_turn'),
      ),
    ).toBe(false);
  });

  it('falls back to sessionId when sessionKey is missing', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionId: 'session-2',
    };

    handleBeforeAgentStart(baseEvent, ctx, config);

    expect(spanStore.get('session-2')).toBeDefined();
  });

  it('returns early when neither sessionKey nor sessionId is present', () => {
    const ctx: AgentContext = { agentId: 'my-agent' };

    handleBeforeAgentStart(baseEvent, ctx, config);

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('uses "agent" as default name when agentId is missing', () => {
    const ctx: AgentContext = { sessionKey: 'session-1' };

    handleBeforeAgentStart(baseEvent, ctx, config);

    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      'invoke_agent agent',
      expect.anything(),
      expect.anything(),
    );
  });

  it('sets channel to "unknown" when messageProvider is missing', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionKey: 'session-1',
    };

    handleBeforeAgentStart(baseEvent, ctx, config);

    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'openclaw.channel': 'unknown',
        }),
      }),
      expect.anything(),
    );
  });

  it('reuses an existing session when multiple root hooks fire', () => {
    const ctx: AgentContext = {
      agentId: 'my-agent',
      sessionKey: 'session-1',
    };

    handleBeforeAgentStart(baseEvent, ctx, config);
    handleBeforeAgentStart(
      {
        ...baseEvent,
        messages: [{ role: 'user', content: 'history' }],
      },
      ctx,
      config,
    );

    expect(mockTracerInstance.startSpan).toHaveBeenCalledTimes(1);
    expect(spanStore.get('session-1')?.initialHistoryMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'history' }] },
    ]);
  });
});
