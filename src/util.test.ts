import { describe, it, expect } from 'vitest';
import {
  safeJsonStringify,
  truncate,
  redactSecrets,
  prepareForCapture,
  extractWorkspaceName,
  generateCallId,
  extractErrorDetails,
  normalizeToGenAiInputMessages,
  normalizeToGenAiOutputMessages,
  buildFullInputMessages,
  buildSystemInstructions,
  buildPydanticAiAllMessages,
  buildAssistantMessagesFromTexts,
  buildMessagesFromConversationHistory,
  extractConversationOutputMessages,
  extractFinalResult,
  normalizeToGenAiToolDefinitions,
} from './util.js';

describe('safeJsonStringify', () => {
  it('serializes objects', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('handles circular references', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = safeJsonStringify(obj);
    expect(result).toContain('"a":1');
    expect(result).toContain('[Circular]');
  });

  it('handles BigInt', () => {
    expect(safeJsonStringify({ n: BigInt(42) })).toBe('{"n":"42"}');
  });
});

describe('truncate', () => {
  it('does not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and adds marker', () => {
    expect(truncate('hello world', 5)).toBe('hello...[truncated]');
  });
});

describe('redactSecrets', () => {
  it('redacts API keys', () => {
    const input = 'curl -H "api_key: sk_live_abc123defgh456"';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk_live_abc123defgh456');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts bearer tokens', () => {
    const input = 'Authorization: Bearer ghp_abcdef1234567890abcdef';
    const result = redactSecrets(input);
    expect(result).not.toContain('ghp_abcdef1234567890abcdef');
  });

  it('redacts JWTs', () => {
    const input =
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('leaves non-secret content alone', () => {
    const input = 'curl https://api.example.com/data -d \'{"name":"test"}\'';
    expect(redactSecrets(input)).toBe(input);
  });
});

describe('prepareForCapture', () => {
  it('serializes, redacts, and truncates', () => {
    const result = prepareForCapture(
      { key: 'api_key: secret123456789012' },
      50,
      true,
    );
    expect(result).toContain('[REDACTED]');
    expect(result.length).toBeLessThanOrEqual(50 + '...[truncated]'.length);
  });

  it('skips redaction when disabled', () => {
    const result = prepareForCapture('api_key: mysecret12345678', 200, false);
    expect(result).toContain('mysecret12345678');
  });
});

describe('extractWorkspaceName', () => {
  it('extracts last path segment', () => {
    expect(extractWorkspaceName('/path/to/workspaces/chief-of-staff')).toBe(
      'chief-of-staff',
    );
  });

  it('handles trailing slash', () => {
    expect(extractWorkspaceName('/workspaces/marketing/')).toBe('marketing');
  });

  it('returns unknown for undefined', () => {
    expect(extractWorkspaceName(undefined)).toBe('unknown');
  });
});

describe('generateCallId', () => {
  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCallId()));
    expect(ids.size).toBe(100);
  });

  it('returns string format', () => {
    const id = generateCallId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/.+-[a-z0-9]+/);
  });
});

describe('normalizeToGenAiOutputMessages', () => {
  it('converts string content to single text part', () => {
    const out = normalizeToGenAiOutputMessages({ role: 'assistant', content: 'Hello' });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].parts).toEqual([{ type: 'text', content: 'Hello' }]);
  });

  it('includes finish_reason when provided', () => {
    const out = normalizeToGenAiOutputMessages(
      { role: 'assistant', content: 'Done' },
      'stop',
    );
    expect(out[0].finish_reason).toBe('stop');
  });

  it('converts content array with text and tool_use to parts', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Call foo' },
        { type: 'tool_use', id: 'call-1', name: 'foo', arguments: { x: 1 } },
      ],
    });
    expect(out[0].parts).toHaveLength(2);
    expect(out[0].parts[0]).toEqual({ type: 'text', content: 'Call foo' });
    expect(out[0].parts[1]).toMatchObject({
      type: 'tool_call',
      id: 'call-1',
      name: 'foo',
      arguments: { x: 1 },
    });
  });

  it('splits OpenClaw thinking block and <final> text block', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'step 1\nstep 2' },
        { type: 'text', text: '<final>\n你好呀\n</final>' },
      ],
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'step 1\nstep 2' },
      { type: 'text', content: '你好呀' },
    ]);
  });

  it('splits <think> and <final> from a single text block', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<think>\n先分析\n</think>\n<final>\n再输出\n</final>',
        },
      ],
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: '先分析' },
      { type: 'text', content: '再输出' },
    ]);
  });

  it('converts camelCase toolCall blocks to tool_call parts', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'load_skills',
          arguments: { skills: ['shot_generation'] },
        },
      ],
    });
    expect(out[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-2',
        name: 'load_skills',
        arguments: { skills: ['shot_generation'] },
      },
    ]);
  });

  it('parses newline-delimited JSON string content from OpenClaw snapshots', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content:
        '{"type":"thinking","thinking":"先读文件"}\n' +
        '{"type":"toolCall","id":"read1","name":"read","arguments":{"file_path":"/tmp/a"}}\n' +
        '{"type":"text","text":"<final>你好呀</final>"}',
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: '先读文件' },
      {
        type: 'tool_call',
        id: 'read1',
        name: 'read',
        arguments: { file_path: '/tmp/a' },
      },
      { type: 'text', content: '你好呀' },
    ]);
  });

  it('returns empty array for null/undefined', () => {
    expect(normalizeToGenAiOutputMessages(null)).toEqual([]);
    expect(normalizeToGenAiOutputMessages(undefined)).toEqual([]);
  });
});

describe('normalizeToGenAiInputMessages', () => {
  it('parses OpenClaw assistant history string with jsonl and final tags', () => {
    const out = normalizeToGenAiInputMessages([
      {
        role: 'assistant',
        content:
          '{"type":"thinking","thinking":"先看上下文"}\n' +
          '{"type":"toolCall","id":"read1","name":"read","arguments":{"file_path":"/tmp/a"}}\n' +
          '<final>你好呀</final>',
      },
    ]);
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: '先看上下文' },
      {
        type: 'tool_call',
        id: 'read1',
        name: 'read',
        arguments: { file_path: '/tmp/a' },
      },
      { type: 'text', content: '你好呀' },
    ]);
  });
});

describe('buildFullInputMessages', () => {
  it('builds system and user messages when system prompt exists', () => {
    const out = buildFullInputMessages('You are helpful', undefined, 'Hello');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      role: 'system',
      parts: [{ type: 'text', content: 'You are helpful' }],
    });
    expect(out[1]).toEqual({ role: 'user', parts: [{ type: 'text', content: 'Hello' }] });
  });

  it('omits system when empty', () => {
    const out = buildFullInputMessages('', [], 'Hi');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].parts[0].content).toBe('Hi');
  });

  it('includes normalized history between system and current user', () => {
    const out = buildFullInputMessages(undefined, [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Reply' },
    ], 'Second');
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('user');
    expect(out[0].parts[0].content).toBe('First');
    expect(out[1].role).toBe('assistant');
    expect(out[1].parts[0].content).toBe('Reply');
    expect(out[2].role).toBe('user');
    expect(out[2].parts[0].content).toBe('Second');
  });
});

describe('buildSystemInstructions', () => {
  it('returns a text instruction part when prompt exists', () => {
    expect(buildSystemInstructions(' You are helpful ')).toEqual([
      { type: 'text', content: 'You are helpful' },
    ]);
  });

  it('returns empty array when prompt is blank', () => {
    expect(buildSystemInstructions('   ')).toEqual([]);
    expect(buildSystemInstructions(undefined)).toEqual([]);
  });
});

describe('buildPydanticAiAllMessages', () => {
  it('concatenates base and assistant messages', () => {
    const out = buildPydanticAiAllMessages(
      [{ role: 'user', parts: [{ type: 'text', content: 'Hi' }] }],
      [{ role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] }],
    );
    expect(out).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hi' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });

  it('handles missing base messages gracefully', () => {
    const out = buildPydanticAiAllMessages(undefined, [
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
    expect(out).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] },
    ]);
  });
});

describe('buildMessagesFromConversationHistory', () => {
  it('keeps tool responses as tool messages for GenAI message rendering', () => {
    expect(
      buildMessagesFromConversationHistory([
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: '/tmp/a' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'write',
          content: [{ type: 'text', text: 'ok' }],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call-1', name: 'write', arguments: { path: '/tmp/a' } }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', name: 'write', result: 'ok' }],
      },
    ]);
  });

  it('keeps tool response names and plain-text results for text blocks', () => {
    expect(
      buildMessagesFromConversationHistory([
        {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'load_skills',
          content: [{ type: 'text', text: '已加载技能' }],
        },
      ]),
    ).toEqual([
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-2',
            name: 'load_skills',
            result: '已加载技能',
          },
        ],
      },
    ]);
  });
});

describe('extractConversationOutputMessages', () => {
  it('extracts only messages produced after current input', () => {
    const fullConversation = [
      { role: 'user', parts: [{ type: 'text', content: '历史消息' }] },
      { role: 'user', parts: [{ type: 'text', content: '当前问题' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'write', arguments: '{}' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', result: 'ok' }] },
      { role: 'assistant', parts: [{ type: 'text', content: '最终回复' }] },
    ];
    const inputMessages = [
      { role: 'system', parts: [{ type: 'text', content: 'System' }] },
      { role: 'user', parts: [{ type: 'text', content: '历史消息' }] },
      { role: 'user', parts: [{ type: 'text', content: '当前问题' }] },
    ];

    expect(extractConversationOutputMessages(fullConversation, inputMessages)).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'write', arguments: '{}' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', result: 'ok' }] },
      { role: 'assistant', parts: [{ type: 'text', content: '最终回复' }] },
    ]);
  });
});

describe('normalizeToGenAiToolDefinitions', () => {
  it('normalizes OpenAI function tool definitions', () => {
    expect(
      normalizeToGenAiToolDefinitions([
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ]),
    ).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
  });

  it('normalizes Anthropic-style tool definitions', () => {
    expect(
      normalizeToGenAiToolDefinitions([
        {
          name: 'read',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      ]),
    ).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ]);
  });
});

describe('buildAssistantMessagesFromTexts', () => {
  it('builds a fallback assistant message from assistantTexts', () => {
    expect(buildAssistantMessagesFromTexts(['第一段', '第二段'], 'stop')).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '第一段\n第二段' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('returns empty array when assistantTexts is empty', () => {
    expect(buildAssistantMessagesFromTexts([], 'stop')).toEqual([]);
    expect(buildAssistantMessagesFromTexts(undefined, 'stop')).toEqual([]);
  });
});

describe('extractFinalResult', () => {
  it('returns the last assistant text content', () => {
    const out = extractFinalResult([
      { role: 'user', parts: [{ type: 'text', content: 'Hi' }] },
      { role: 'assistant', parts: [{ type: 'thinking', content: 'step' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello there' }] },
    ]);
    expect(out).toBe('Hello there');
  });

  it('returns undefined when assistant has no text part', () => {
    const out = extractFinalResult([
      { role: 'assistant', parts: [{ type: 'thinking', content: 'step' }] },
    ]);
    expect(out).toBeUndefined();
  });
});

describe('extractErrorDetails', () => {
  it('extracts from Error objects', () => {
    const err = new TypeError('bad input');
    const details = extractErrorDetails(err);
    expect(details.type).toBe('TypeError');
    expect(details.message).toBe('bad input');
    expect(details.stacktrace).toContain('TypeError');
  });

  it('handles string errors', () => {
    const details = extractErrorDetails('something failed');
    expect(details.type).toBe('Error');
    expect(details.message).toBe('something failed');
  });

  it('handles unknown error types', () => {
    const details = extractErrorDetails({ code: 42 });
    expect(details.type).toBe('Error');
    expect(details.message).toContain('42');
  });
});
