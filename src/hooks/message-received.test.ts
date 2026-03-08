import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spanStore } from '../context/span-store.js';
import { mockSpan, mockContext, createTestConfig } from '../test-helpers.js';
import { handleMessageReceived } from './message-received.js';
import type { MessageReceivedEvent, MessageContext } from './message-received.js';

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
  });
  return agentSpan;
}

describe('handleMessageReceived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanStore.delete('conv-1');
  });

  afterEach(() => {
    spanStore.delete('conv-1');
  });

  const baseEvent: MessageReceivedEvent = {
    from: 'user-123',
    content: 'Hello agent',
    timestamp: Date.now(),
  };

  const baseCtx: MessageContext = {
    channelId: 'slack-general',
    accountId: 'acct-1',
    conversationId: 'conv-1',
  };

  it('sets channel attribute on agent span', () => {
    const agentSpan = seedSession('conv-1');

    handleMessageReceived(baseEvent, baseCtx, createTestConfig());

    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'openclaw.channel',
      'slack-general',
    );
  });

  it('sets sender_id attribute on agent span', () => {
    const agentSpan = seedSession('conv-1');

    handleMessageReceived(baseEvent, baseCtx, createTestConfig());

    expect(agentSpan.setAttribute).toHaveBeenCalledWith(
      'openclaw.sender_id',
      'user-123',
    );
  });

  it('returns early when conversationId is missing', () => {
    const agentSpan = seedSession('conv-1');
    const ctx: MessageContext = { channelId: 'slack' };

    handleMessageReceived(baseEvent, ctx, createTestConfig());

    expect(agentSpan.setAttribute).not.toHaveBeenCalled();
  });

  it('returns early when session is not found', () => {
    // Don't seed a session — conversationId won't match
    const ctx: MessageContext = {
      channelId: 'slack',
      conversationId: 'nonexistent',
    };

    // Should not throw
    handleMessageReceived(baseEvent, ctx, createTestConfig());
  });

  it('does not set channel when channelId is empty', () => {
    const agentSpan = seedSession('conv-1');
    const ctx: MessageContext = { channelId: '', conversationId: 'conv-1' };

    handleMessageReceived(baseEvent, ctx, createTestConfig());

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasChannel = calls.some(([key]: [string]) => key === 'openclaw.channel');
    expect(hasChannel).toBe(false);
  });

  it('does not set sender_id when from is empty', () => {
    const agentSpan = seedSession('conv-1');
    const event: MessageReceivedEvent = { from: '', content: 'Hello' };

    handleMessageReceived(event, baseCtx, createTestConfig());

    const calls = (agentSpan.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
    const hasSender = calls.some(([key]: [string]) => key === 'openclaw.sender_id');
    expect(hasSender).toBe(false);
  });
});
