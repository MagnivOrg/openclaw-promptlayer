// SPDX-License-Identifier: MIT

import { safeJsonStringify, type GenAiChatMessage } from './util.js';

type SpanAttributeMap = Record<string, string | number | string[]>;

function extractMessageContent(message: GenAiChatMessage): string | undefined {
  const text = message.parts
    .filter(
      (part) =>
        (part.type === 'text' || part.type === 'thinking') &&
        typeof part.content === 'string',
    )
    .map((part) => String(part.content))
    .filter((part) => part !== '')
    .join('\n');
  return text === '' ? undefined : text;
}

function extractToolCalls(message: GenAiChatMessage): unknown[] {
  return message.parts
    .filter((part) => part.type === 'tool_call')
    .map((part) => ({
      id: part.id,
      type: 'function',
      function: {
        name: part.name,
        arguments:
          typeof part.arguments === 'string'
            ? part.arguments
            : safeJsonStringify(part.arguments ?? {}),
      },
    }));
}

function extractToolResponse(
  message: GenAiChatMessage,
): { content: string; toolCallId?: string; name?: string } | undefined {
  const responsePart = message.parts.find((part) => part.type === 'tool_call_response');
  if (!responsePart) return undefined;
  const result =
    responsePart.result !== undefined
      ? responsePart.result
      : responsePart.response !== undefined
        ? responsePart.response
        : '';
  return {
    content: typeof result === 'string' ? result : safeJsonStringify(result),
    toolCallId: responsePart.id,
    name: responsePart.name,
  };
}

export function addIndexedMessages(
  attributes: SpanAttributeMap,
  prefix: 'gen_ai.prompt' | 'gen_ai.completion',
  messages: GenAiChatMessage[],
): void {
  messages.forEach((message, index) => {
    attributes[`${prefix}.${index}.role`] = message.role;

    const toolResponse = extractToolResponse(message);
    const content = toolResponse?.content ?? extractMessageContent(message);
    if (content !== undefined) {
      attributes[`${prefix}.${index}.content`] = content;
    }

    const toolCalls = extractToolCalls(message);
    if (toolCalls.length > 0) {
      attributes[`${prefix}.${index}.tool_calls`] = safeJsonStringify(toolCalls);
    }

    if (toolResponse?.toolCallId) {
      attributes[`${prefix}.${index}.tool_call_id`] = toolResponse.toolCallId;
    }
    if (toolResponse?.name) {
      attributes[`${prefix}.${index}.name`] = toolResponse.name;
    }
    if (message.finish_reason) {
      attributes[`${prefix}.${index}.finish_reason`] = message.finish_reason;
    }
  });
}

export function addUsageAttributes(
  attributes: SpanAttributeMap,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
): void {
  if (usage.input !== undefined) {
    attributes['gen_ai.usage.input_tokens'] = usage.input;
  }
  if (usage.output !== undefined) {
    attributes['gen_ai.usage.output_tokens'] = usage.output;
  }
  if (usage.cacheRead !== undefined) {
    attributes['openclaw.usage.cache_read_tokens'] = usage.cacheRead;
  }
  if (usage.cacheWrite !== undefined) {
    attributes['openclaw.usage.cache_write_tokens'] = usage.cacheWrite;
  }
}
