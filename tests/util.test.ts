import { describe, it, expect } from 'vitest';
import {
  safeJsonStringify,
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
} from '../src/util.js';

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

describe('prepareForCapture', () => {
  it('serializes objects without mutating content', () => {
    const result = prepareForCapture({ key: 'api_key: secret123456789012' });
    expect(result).toBe('{"key":"api_key: secret123456789012"}');
  });

  it('passes strings through unchanged', () => {
    expect(prepareForCapture('api_key: mysecret12345678')).toBe(
      'api_key: mysecret12345678',
    );
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
        { type: 'text', text: '<final>\nhello there\n</final>' },
      ],
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'step 1\nstep 2' },
      { type: 'text', content: 'hello there' },
    ]);
  });

  it('splits <think> and <final> from a single text block', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<think>\nanalyze first\n</think>\n<final>\nthen answer\n</final>',
        },
      ],
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'analyze first' },
      { type: 'text', content: 'then answer' },
    ]);
  });

  it('converts OpenAI reasoning summaries to thinking parts', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'I should compute directly.' }],
        },
        { type: 'output_text', text: 'The answer is 437.' },
      ],
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'I should compute directly.' },
      { type: 'text', content: 'The answer is 437.' },
    ]);
  });

  it('converts reasoning_content fields to thinking parts', () => {
    const out = normalizeToGenAiOutputMessages({
      role: 'assistant',
      reasoning_content: 'check the file first',
      content: 'Done.',
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'check the file first' },
      { type: 'text', content: 'Done.' },
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
        '{"type":"thinking","thinking":"read file first"}\n' +
        '{"type":"toolCall","id":"read1","name":"read","arguments":{"file_path":"/tmp/a"}}\n' +
        '{"type":"text","text":"<final>hello there</final>"}',
    });
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'read file first' },
      {
        type: 'tool_call',
        id: 'read1',
        name: 'read',
        arguments: { file_path: '/tmp/a' },
      },
      { type: 'text', content: 'hello there' },
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
          '{"type":"thinking","thinking":"check context first"}\n' +
          '{"type":"toolCall","id":"read1","name":"read","arguments":{"file_path":"/tmp/a"}}\n' +
          '<final>hello there</final>',
      },
    ]);
    expect(out[0].parts).toEqual([
      { type: 'thinking', content: 'check context first' },
      {
        type: 'tool_call',
        id: 'read1',
        name: 'read',
        arguments: { file_path: '/tmp/a' },
      },
      { type: 'text', content: 'hello there' },
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
          content: [{ type: 'text', text: 'skill loaded' }],
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
            result: 'skill loaded',
          },
        ],
      },
    ]);
  });
});

describe('extractConversationOutputMessages', () => {
  it('extracts only messages produced after current input', () => {
    const fullConversation = [
      { role: 'user', parts: [{ type: 'text', content: 'history message' }] },
      { role: 'user', parts: [{ type: 'text', content: 'current question' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'write', arguments: '{}' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', result: 'ok' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'final response' }] },
    ];
    const inputMessages = [
      { role: 'system', parts: [{ type: 'text', content: 'System' }] },
      { role: 'user', parts: [{ type: 'text', content: 'history message' }] },
      { role: 'user', parts: [{ type: 'text', content: 'current question' }] },
    ];

    expect(extractConversationOutputMessages(fullConversation, inputMessages)).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'write', arguments: '{}' }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', result: 'ok' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'final response' }] },
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
    expect(buildAssistantMessagesFromTexts(['first segment', 'second segment'], 'stop')).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'first segment\nsecond segment' }],
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
