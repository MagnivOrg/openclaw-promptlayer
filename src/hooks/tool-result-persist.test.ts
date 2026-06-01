import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleToolResultPersist } from './tool-result-persist.js';
import type { ToolResultPersistEvent, ToolResultPersistContext } from './tool-result-persist.js';

function seedSessionWithTool(sessionKey: string, toolName: string) {
  const toolSpan = mockSpan();

  spanStore.set(sessionKey, {
    agentSpan: mockSpan(),
    agentCtx: mockContext(),
    toolStack: [],
    llmSpans: new Map(),
    completedToolCalls: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 1,
    hasError: false,
    startTime: Date.now(),
    latestAllMessages: [],
    latestSystemInstructions: [],
    initialHistoryMessages: [],
  });

  spanStore.pushTool(sessionKey, {
    span: toolSpan,
    ctx: mockContext(),
    name: toolName,
    callId: 'call-1',
    startTime: Date.now() - 100, // 100ms ago for duration testing
  });

  return toolSpan;
}

describe('handleToolResultPersist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('sess-1');
  });

  afterEach(() => {
    spanStore.delete('sess-1');
  });

  const baseEvent: ToolResultPersistEvent = {
    toolName: 'Read',
    toolCallId: 'call-1',
    message: 'file contents here',
  };

  const baseCtx: ToolResultPersistContext = {
    agentId: 'my-agent',
    sessionKey: 'sess-1',
    toolName: 'Read',
    toolCallId: 'call-1',
  };

  it('closes the tool span with OK status', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');

    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());

    expect(toolSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan.end).toHaveBeenCalled();
  });

  it('records duration and output size attributes', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');

    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());

    expect(toolSpan.setAttribute).toHaveBeenCalledWith(
      'openclaw.tool.duration_ms',
      expect.any(Number),
    );
    expect(toolSpan.setAttribute).toHaveBeenCalledWith(
      'openclaw.tool.output_size',
      'file contents here'.length,
    );
  });

  it('captures tool output when captureToolOutput is enabled', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');
    const config = createTestConfig({ captureToolOutput: true });

    handleToolResultPersist(baseEvent, baseCtx, config);

    expect(toolSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.tool.call.result',
      expect.any(String),
    );
  });

  it('does not capture tool output by default', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');

    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());

    const calls = (toolSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasResult = calls.some(([key]: [string]) => key === 'gen_ai.tool.call.result');
    expect(hasResult).toBe(false);
  });

  it('handles object messages (serializes to JSON for size)', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');
    const event: ToolResultPersistEvent = {
      ...baseEvent,
      message: { data: [1, 2, 3] },
    };

    handleToolResultPersist(event, baseCtx, createTestConfig());

    expect(toolSpan.setAttribute).toHaveBeenCalledWith(
      'openclaw.tool.output_size',
      expect.any(Number),
    );
  });

  it('pops from tool stack (LIFO order)', () => {
    // Push two tools
    const span1 = mockSpan();
    const span2 = mockSpan();

    spanStore.set('sess-1', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      completedToolCalls: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 2,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
      initialHistoryMessages: [],
    });

    spanStore.pushTool('sess-1', {
      span: span1, ctx: mockContext(), name: 'Read', callId: 'c1', startTime: Date.now(),
    });
    spanStore.pushTool('sess-1', {
      span: span2, ctx: mockContext(), name: 'Write', callId: 'c2', startTime: Date.now(),
    });

    // First persist should close Write (LIFO)
    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());
    expect(span2.end).toHaveBeenCalled();
    expect(span1.end).not.toHaveBeenCalled();

    // Second persist should close Read
    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());
    expect(span1.end).toHaveBeenCalled();
  });

  it('returns early when sessionKey is missing', () => {
    const ctx: ToolResultPersistContext = { toolName: 'Read' };
    // Should not throw
    handleToolResultPersist(baseEvent, ctx, createTestConfig());
  });

  it('returns early when no tool span exists on stack', () => {
    // Session exists but tool stack is empty
    spanStore.set('sess-1', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
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

    // Should not throw
    handleToolResultPersist(baseEvent, baseCtx, createTestConfig());
  });

  it('always ends span even if setAttribute throws', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');
    // Make setAttribute throw on a specific call
    let callCount = 0;
    (toolSpan.setAttribute as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('attribute error');
      return toolSpan;
    });

    // Should throw but span.end should still be called (in finally block)
    expect(() => handleToolResultPersist(baseEvent, baseCtx, createTestConfig())).toThrow();
    expect(toolSpan.end).toHaveBeenCalled();
  });

  it('captures tool output when message content capture is enabled', () => {
    const toolSpan = seedSessionWithTool('sess-1', 'Read');

    handleToolResultPersist(
      baseEvent,
      baseCtx,
      createTestConfig({ captureMessageContent: true }),
    );

    expect(toolSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.tool.call.result',
      expect.any(String),
    );
  });

});
