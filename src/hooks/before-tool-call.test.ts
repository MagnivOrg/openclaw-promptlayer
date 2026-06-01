import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanKind } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleBeforeToolCall } from './before-tool-call.js';
import type { BeforeToolCallEvent, ToolContext } from './before-tool-call.js';

const { mockToolSpan, mockTracerInstance, mockSetSpan } = vi.hoisted(() => {
  const toolSpan = {
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
    mockToolSpan: toolSpan,
    mockTracerInstance: {
      startSpan: vi.fn(() => toolSpan),
    },
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
    SpanKind: actual.SpanKind,
  };
});

vi.mock('../otel.js', () => ({
  getPromptLayerTracer: vi.fn(() => mockTracerInstance),
}));

function seedSession(sessionKey: string) {
  const agentCtx = mockContext();
  spanStore.set(sessionKey, {
    agentSpan: mockSpan(),
    agentCtx,
    toolStack: [],
    llmSpans: new Map(),
    completedToolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    hasError: false,
    startTime: Date.now(),
    latestAllMessages: [],
    latestSystemInstructions: [],
    initialHistoryMessages: [],
  });
  return { agentCtx };
}

describe('handleBeforeToolCall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    spanStore.delete('sess-1');
  });

  const baseEvent: BeforeToolCallEvent = {
    toolName: 'Read',
    params: { path: '/src/index.ts' },
  };

  const baseCtx: ToolContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    toolName: 'Read',
  };

  it('creates a tool span with correct name and attributes', () => {
    const { agentCtx } = seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    const lastCall = mockTracerInstance.startSpan.mock.calls.at(-1);
    expect(lastCall).toEqual([
      'execute_tool Read',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'Read',
          'gen_ai.tool.type': 'function',
        }),
      }),
      agentCtx,
    ]);
  });

  it('parents tool spans directly under the session root context', () => {
    const { agentCtx } = seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan.mock.calls.at(-1)?.[2]).toBe(agentCtx);
  });

  it('uses OpenClaw toolCallId when provided', () => {
    seedSession('sess-1');

    handleBeforeToolCall(
      { ...baseEvent, toolCallId: 'write_123' },
      { ...baseCtx, toolCallId: 'write_123' },
      createTestConfig(),
    );

    const lastCall = mockTracerInstance.startSpan.mock.calls.at(-1);
    expect(lastCall).toEqual([
      expect.anything(),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'gen_ai.tool.call.id': 'write_123',
        }),
      }),
      expect.anything(),
    ]);
  });

  it('pushes the tool span onto the session stack', () => {
    seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    const tool = spanStore.peekTool('sess-1');
    expect(tool).toBeDefined();
    expect(tool!.span).toBe(mockToolSpan);
    expect(tool!.name).toBe('Read');
  });

  it('increments tool sequence counter', () => {
    seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    const session = spanStore.get('sess-1')!;
    expect(session.toolSequence).toBe(1);
  });

  it('increments sequence across multiple tool calls', () => {
    seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());
    // Pop the first to avoid stack confusion
    spanStore.popTool('sess-1');

    handleBeforeToolCall(
      { toolName: 'Write', params: { path: '/a' } },
      baseCtx,
      createTestConfig(),
    );

    const session = spanStore.get('sess-1')!;
    expect(session.toolSequence).toBe(2);
  });

  it('captures tool input when captureToolInput is enabled', () => {
    seedSession('sess-1');
    const config = createTestConfig({ captureToolInput: true });

    handleBeforeToolCall(baseEvent, baseCtx, config);

    const lastCall = mockTracerInstance.startSpan.mock.calls.at(-1);
    expect(lastCall).toEqual([
      expect.anything(),
      expect.objectContaining({
        attributes: expect.objectContaining({
          'gen_ai.tool.call.arguments': expect.any(String),
        }),
      }),
      expect.anything(),
    ]);
  });

  it('does not capture tool input by default', () => {
    seedSession('sess-1');

    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    const lastCall = mockTracerInstance.startSpan.mock.calls.at(-1) as
      | [string, { attributes: Record<string, unknown> }, unknown]
      | undefined;
    expect(lastCall).toBeDefined();
    const attrs = lastCall![1].attributes;
    expect(attrs).not.toHaveProperty('gen_ai.tool.call.arguments');
  });

  it('returns early when sessionKey is missing', () => {
    const ctx: ToolContext = { toolName: 'Read' };

    handleBeforeToolCall(baseEvent, ctx, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', () => {
    handleBeforeToolCall(baseEvent, baseCtx, createTestConfig());

    expect(mockTracerInstance.startSpan).not.toHaveBeenCalled();
  });

  it('falls back to event.toolName when ctx.toolName is empty', () => {
    seedSession('sess-1');
    const ctx: ToolContext = { sessionKey: 'sess-1', toolName: '' };
    const event: BeforeToolCallEvent = { toolName: 'Bash' };

    handleBeforeToolCall(event, ctx, createTestConfig());

    const lastCall = mockTracerInstance.startSpan.mock.calls.at(-1);
    expect(lastCall).toEqual([
      'execute_tool Bash',
      expect.anything(),
      expect.anything(),
    ]);
  });

  it('creates only the execute_tool span when runId is present', () => {
    seedSession('sess-1');

    handleBeforeToolCall(
      { ...baseEvent, runId: 'run-1' },
      { ...baseCtx, runId: 'run-1' },
      createTestConfig(),
    );

    expect(mockTracerInstance.startSpan).toHaveBeenCalledTimes(1);
    expect(mockTracerInstance.startSpan).toHaveBeenCalledWith(
      'execute_tool Read',
      expect.anything(),
      expect.anything(),
    );
  });

  it('creates sibling execute_tool spans across multiple tool calls', () => {
    seedSession('sess-1');

    handleBeforeToolCall(
      { ...baseEvent, runId: 'run-1' },
      { ...baseCtx, runId: 'run-1' },
      createTestConfig(),
    );

    handleBeforeToolCall(
      { toolName: 'Write', params: { path: '/tmp/a' }, runId: 'run-1' },
      { ...baseCtx, toolName: 'Write', runId: 'run-1' },
      createTestConfig(),
    );

    expect(mockTracerInstance.startSpan).toHaveBeenCalledTimes(2);
    expect(mockTracerInstance.startSpan.mock.calls.map((call) => call[0])).toEqual([
      'execute_tool Read',
      'execute_tool Write',
    ]);
  });
});
