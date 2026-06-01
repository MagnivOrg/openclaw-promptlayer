// SPDX-License-Identifier: MIT

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { LlmSpanEntry } from '../context/span-store.js';
import type { PromptLayerPluginConfig } from '../config.js';
import {
  resolveGenAiSystemName,
  prepareForCapture,
  safeJsonStringify,
  type GenAiChatMessage,
} from '../util.js';
import { getPromptLayerTracer } from '../otel.js';
import { addIndexedMessages, addUsageAttributes } from '../gen-ai-span-attributes.js';
import type { LlmOutputEvent } from './llm-output.js';

export function hasTextOutput(messages: GenAiChatMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === 'text' &&
        typeof part.content === 'string' &&
        part.content.trim() !== '',
    ),
  );
}

function stripLeadingSystemMessages(messages: GenAiChatMessage[]): GenAiChatMessage[] {
  let firstNonSystemIndex = 0;
  while (
    firstNonSystemIndex < messages.length &&
    messages[firstNonSystemIndex]?.role === 'system'
  ) {
    firstNonSystemIndex += 1;
  }
  return messages.slice(firstNonSystemIndex);
}

function countToolCalls(messages: GenAiChatMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.parts.filter((part) => part.type === 'tool_call').length,
    0,
  );
}

export function hasToolCall(messages: GenAiChatMessage[]): boolean {
  return countToolCalls(messages) > 0;
}

export function createChatSpan(
  llmEntry: LlmSpanEntry,
  inputMessages: GenAiChatMessage[],
  outputMessages: GenAiChatMessage[],
  parentCtx: Context,
  finishReason: string | undefined,
  responseId: string | undefined,
  usage: LlmOutputEvent['usage'],
  endTime: number,
  config: PromptLayerPluginConfig,
): void {
  const tracer = getPromptLayerTracer();
  const spanName = `chat ${llmEntry.model || llmEntry.provider || 'unknown'}`;
  const conversationId = llmEntry.sessionKey || 'unknown';
  const attributes: Record<string, string | number | string[]> = {
    'gen_ai.operation.name': 'chat',
    'gen_ai.agent.name': llmEntry.agentName,
    'gen_ai.conversation.id': conversationId,
    'gen_ai.system': resolveGenAiSystemName(llmEntry.provider, llmEntry.model),
    'gen_ai.request.model': llmEntry.model,
    'gen_ai.provider.name': llmEntry.provider,
    'gen_ai.response.model': llmEntry.model,
    'session.id': conversationId,
    'openclaw.llm.run_id': llmEntry.runId,
  };

  if (config.captureMessageContent) {
    const inputMessagesForChatSpan =
      llmEntry.systemInstructions.length > 0
        ? stripLeadingSystemMessages(inputMessages)
        : inputMessages;
    if (inputMessagesForChatSpan.length > 0) {
      attributes['gen_ai.input.messages'] = prepareForCapture(
        inputMessagesForChatSpan,
        config.historyMessagesMaxLength,
        config.redactSecrets,
      );
      addIndexedMessages(attributes, 'gen_ai.prompt', inputMessagesForChatSpan);
    }
    if (llmEntry.systemInstructions.length > 0) {
      attributes['gen_ai.system_instructions'] = prepareForCapture(
        llmEntry.systemInstructions,
        config.toolInputMaxLength,
        config.redactSecrets,
      );
    }
    if (Array.isArray(llmEntry.toolDefinitions) && llmEntry.toolDefinitions.length > 0) {
      attributes['gen_ai.tool.definitions'] = safeJsonStringify(llmEntry.toolDefinitions);
    }
    if (outputMessages.length > 0) {
      attributes['gen_ai.output.messages'] = prepareForCapture(
        outputMessages,
        config.toolOutputMaxLength,
        config.redactSecrets,
      );
      addIndexedMessages(attributes, 'gen_ai.completion', outputMessages);
    }
  }

  const outputHasToolCall = hasToolCall(outputMessages);
  const resolvedFinishReason =
    finishReason && finishReason !== ''
      ? finishReason
      : outputHasToolCall
        ? 'tool_call'
        : undefined;
  if (resolvedFinishReason) {
    attributes['gen_ai.response.finish_reasons'] = [resolvedFinishReason];
  }
  if (resolvedFinishReason !== 'tool_call' && typeof responseId === 'string' && responseId !== '') {
    attributes['gen_ai.response.id'] = responseId;
  }
  if (usage) {
    addUsageAttributes(attributes, usage);
  }

  const span = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes,
      startTime: llmEntry.startTime,
    },
    parentCtx,
  );
  span.setStatus({ code: SpanStatusCode.OK });
  span.end(endTime);
}
