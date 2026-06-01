import { describe, it, expect, beforeEach } from 'vitest';
import { spanStore } from './span-store.js';

// Minimal mock spans for testing store logic
function mockSpan(): any {
  return {
    end: () => {},
    spanContext: () => ({ traceId: 'abc', spanId: 'def' }),
    setAttribute: () => {},
    setStatus: () => {},
    addEvent: () => {},
    addLink: () => {},
    recordException: () => {},
  };
}

function mockContext(): any {
  return {};
}

describe('SpanStore', () => {
  beforeEach(() => {
    // Clear the store between tests
    spanStore.delete('test-session');
    spanStore.delete('test-session-2');
  });

  it('stores and retrieves sessions', () => {
    spanStore.set('test-session', {
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
    });

    const session = spanStore.get('test-session');
    expect(session).toBeDefined();
    expect(session!.toolSequence).toBe(0);
  });

  it('returns undefined for unknown sessions', () => {
    expect(spanStore.get('nonexistent')).toBeUndefined();
  });

  it('pushes and pops tool spans (LIFO)', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    spanStore.pushTool('test-session', {
      span: mockSpan(),
      ctx: mockContext(),
      name: 'Read',
      callId: 'call-1',
      startTime: Date.now(),
    });

    spanStore.pushTool('test-session', {
      span: mockSpan(),
      ctx: mockContext(),
      name: 'Write',
      callId: 'call-2',
      startTime: Date.now(),
    });

    // LIFO: Write comes off first
    const first = spanStore.popTool('test-session');
    expect(first?.name).toBe('Write');

    const second = spanStore.popTool('test-session');
    expect(second?.name).toBe('Read');

    const third = spanStore.popTool('test-session');
    expect(third).toBeUndefined();
  });

  it('peeks without removing', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    spanStore.pushTool('test-session', {
      span: mockSpan(),
      ctx: mockContext(),
      name: 'exec',
      callId: 'call-1',
      startTime: Date.now(),
    });

    expect(spanStore.peekTool('test-session')?.name).toBe('exec');
    expect(spanStore.peekTool('test-session')?.name).toBe('exec');
  });

  it('deletes sessions', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    spanStore.delete('test-session');
    expect(spanStore.get('test-session')).toBeUndefined();
  });

  it('stores and retrieves LLM spans by runId', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    const entry = {
      span: mockSpan(),
      ctx: mockContext(),
      runId: 'run-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      startTime: Date.now(),
      inputMessages: [],
      systemInstructions: [],
    };

    spanStore.setLlmSpan('test-session', 'run-1', entry);
    expect(spanStore.getLlmSpan('test-session', 'run-1')).toBe(entry);
    expect(spanStore.getLlmSpan('test-session', 'run-2')).toBeUndefined();
  });

  it('deletes LLM spans and returns them', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    const entry = {
      span: mockSpan(),
      ctx: mockContext(),
      runId: 'run-1',
      provider: 'openai',
      model: 'gpt-4o',
      startTime: Date.now(),
      inputMessages: [],
      systemInstructions: [],
    };

    spanStore.setLlmSpan('test-session', 'run-1', entry);
    const deleted = spanStore.deleteLlmSpan('test-session', 'run-1');
    expect(deleted).toBe(entry);
    expect(spanStore.getLlmSpan('test-session', 'run-1')).toBeUndefined();
  });

  it('returns undefined when deleting nonexistent LLM span', () => {
    spanStore.set('test-session', {
      agentSpan: mockSpan(),
      agentCtx: mockContext(),
      toolStack: [],
      llmSpans: new Map(),
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolSequence: 0,
      hasError: false,
      startTime: Date.now(),
      latestAllMessages: [],
      latestSystemInstructions: [],
    });

    expect(spanStore.deleteLlmSpan('test-session', 'nope')).toBeUndefined();
    expect(spanStore.deleteLlmSpan('nonexistent', 'nope')).toBeUndefined();
  });
});
