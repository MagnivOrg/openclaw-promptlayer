// SPDX-License-Identifier: MIT
/**
 * Shared utilities: safe JSON serialization, truncation, secret redaction.
 */

/** Patterns that likely indicate secret values. */
const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|auth|credential|bearer)\s*[:=]\s*["']?[^\s"',}{]{8,}/gi,
  /(?:sk|pk|rk|pat|ghp|gho|glpat|xox[bpras])[_-][A-Za-z0-9_-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // JWT
];

/**
 * Serialize a value to JSON, handling circular refs and BigInts.
 * Returns an empty string on failure rather than throwing.
 */
export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/** Truncate a string to maxLength, appending "...[truncated]" if needed. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + '...[truncated]';
}

/** Redact likely secrets from a string. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // Keep the key name, redact the value portion
      const eqIdx = match.search(/[:=]/);
      if (eqIdx !== -1) {
        return match.slice(0, eqIdx + 1) + ' [REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return result;
}

/**
 * Prepare a tool input/output value for recording as a span attribute.
 * Serializes to JSON, optionally redacts secrets, and truncates.
 */
export function prepareForCapture(
  value: unknown,
  maxLength: number,
  redact: boolean,
): string {
  let str = typeof value === 'string' ? value : safeJsonStringify(value);
  if (redact) {
    str = redactSecrets(str);
  }
  return truncate(str, maxLength);
}

/**
 * Resolve OpenClaw provider id to OTel/Logfire gen_ai.provider.name.
 * If providerNameMap[provider] exists (e.g. gmn -> openai), use it; otherwise return provider.
 */
export function resolveProviderName(
  provider: string | undefined,
  providerNameMap: Record<string, string> | undefined,
): string {
  if (provider && providerNameMap && typeof providerNameMap[provider] === 'string') {
    return providerNameMap[provider];
  }
  return provider ?? '';
}

/**
 * Resolve OTel `gen_ai.system` from provider/model.
 * This field represents the vendor/system family, not the system prompt text.
 */
export function resolveGenAiSystemName(
  provider: string | undefined,
  model: string | undefined,
): string {
  const normalizedProvider = (provider ?? '').toLowerCase();
  const normalizedModel = (model ?? '').toLowerCase();

  if (
    normalizedProvider === 'google' ||
    normalizedProvider === 'gmn' ||
    normalizedModel.startsWith('gemini')
  ) {
    return 'gemini';
  }
  if (normalizedProvider.includes('anthropic') || normalizedModel.startsWith('claude')) {
    return 'anthropic';
  }
  if (normalizedProvider.includes('openai') || normalizedModel.startsWith('gpt')) {
    return 'openai';
  }

  return provider ?? 'unknown';
}

/** OTel / Pydantic AI 兼容的消息 part。 */
export interface GenAiMessagePart {
  type: string;
  content?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown> | string;
  result?: string | Record<string, unknown>;
  response?: string | Record<string, unknown>;
}

/** OTel GenAI 单条消息：role + parts，用于 gen_ai.input.messages / gen_ai.output.messages */
export interface GenAiChatMessage {
  role: string;
  parts: GenAiMessagePart[];
  name?: string;
  finish_reason?: string;
}

/** system instructions 的最小结构。 */
export interface SystemInstructionPart {
  type: 'text';
  content: string;
}

/** JSON schema property 定义。 */
export interface JsonSchemaProperty {
  type?: 'array' | 'object' | 'string' | 'number' | 'boolean';
}

/** 输入消息规范化选项。 */
export interface NormalizeInputMessagesOptions {
  toolResultRole?: 'tool' | 'user';
}

/**
 * Normalize OpenClaw/OpenAI-style message list to OTel GenAI gen_ai.input.messages format
 * (Input messages JSON schema) for Logfire LLM Panels (multi-turn + tool call/response).
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json
 */
export function normalizeToGenAiInputMessages(
  messages: unknown[],
  options?: NormalizeInputMessagesOptions,
): GenAiChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const out: GenAiChatMessage[] = [];
  const toolResultRole = options?.toolResultRole ?? 'user';

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const raw = msg as Record<string, unknown>;
    const originalRole = typeof raw.role === 'string' ? raw.role : 'user';
    let role = originalRole;
    if (role === 'toolResult') role = toolResultRole;
    const rawToolCallId =
      typeof raw.tool_call_id === 'string'
        ? raw.tool_call_id
        : typeof raw.toolCallId === 'string'
          ? raw.toolCallId
          : '';
    const rawToolName =
      typeof raw.toolName === 'string'
        ? raw.toolName
        : typeof raw.tool_name === 'string'
          ? raw.tool_name
          : undefined;

    const parts: GenAiMessagePart[] = [];
    const content = raw.content;

    if (content === undefined || content === null) {
      parts.push({ type: 'text', content: '' });
    } else if (typeof content === 'string') {
      if (originalRole === 'toolResult') {
        parts.push({
          type: 'tool_call_response',
          id: rawToolCallId,
          name: rawToolName,
          result: content,
        });
      } else {
        appendOutputPartsFromString(parts, content);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (originalRole === 'toolResult') {
          if (typeof block === 'string') {
            parts.push({
              type: 'tool_call_response',
              id: rawToolCallId,
              name: rawToolName,
              result: block,
            });
          } else if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (
              (b.type === 'tool_result' || b.type === 'tool_call_response') &&
              (b.content !== undefined || b.response !== undefined)
            ) {
              const rid = b.id ?? b.tool_call_id;
              parts.push({
                type: 'tool_call_response',
                id: typeof rid === 'string' ? rid : rawToolCallId,
                name: typeof b.name === 'string' ? b.name : rawToolName,
                result:
                  b.result !== undefined
                    ? String(b.result)
                    : String(b.response ?? b.content ?? ''),
                response: String(b.response ?? b.content ?? ''),
              });
            } else if (
              (b.type === 'text' || b.type === 'output_text') &&
              typeof b.text === 'string'
            ) {
              parts.push({
                type: 'tool_call_response',
                id: rawToolCallId,
                name: rawToolName,
                result: b.text,
              });
            } else {
              parts.push({
                type: 'tool_call_response',
                id: rawToolCallId,
                name: rawToolName,
                result: safeJsonStringify(block),
              });
            }
          } else {
            parts.push({
              type: 'tool_call_response',
              id: rawToolCallId,
              name: rawToolName,
              result: safeJsonStringify(block),
            });
          }
        } else {
          appendOutputPartFromBlock(parts, block);
        }
      }
    } else {
      if (originalRole === 'toolResult') {
        parts.push({
          type: 'tool_call_response',
          id: rawToolCallId,
          name: rawToolName,
          result: safeJsonStringify(content),
        });
      } else {
        parts.push({ type: 'text', content: safeJsonStringify(content) });
      }
    }

    if (parts.length === 0) parts.push({ type: 'text', content: '' });
    out.push({ role, parts });
  }

  return out;
}

/**
 * 将 OpenClaw/OpenAI/Anthropic 样式的单条 assistant 消息转为 OTel GenAI gen_ai.output.messages 格式。
 * 支持：content 字符串、content 数组（text / tool_use / reasoning）、tool_calls。
 * Logfire 据此正确解析多轮、工具调用、思考内容为富文本。
 */
function appendTaggedOutputParts(parts: GenAiMessagePart[], rawText: string): void {
  if (rawText === '') return;

  const taggedPattern = /<think>([\s\S]*?)<\/think>|<final>([\s\S]*?)<\/final>/g;
  const matches = Array.from(rawText.matchAll(taggedPattern));

  if (matches.length === 0) {
    parts.push({ type: 'text', content: rawText });
    return;
  }

  for (const match of matches) {
    const thinkContent = match[1]?.trim();
    const finalContent = match[2]?.trim();

    if (thinkContent) {
      parts.push({ type: 'thinking', content: thinkContent });
    }
    if (finalContent) {
      parts.push({ type: 'text', content: finalContent });
    }
  }
}

function appendOutputPartsFromString(parts: GenAiMessagePart[], rawText: string): void {
  if (rawText === '') return;

  const lines = rawText.split(/\r?\n/);
  let plainTextBuffer = '';

  const flushPlainTextBuffer = (): void => {
    if (plainTextBuffer === '') return;
    appendTaggedOutputParts(parts, plainTextBuffer);
    plainTextBuffer = '';
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
      try {
        const parsedLine = JSON.parse(trimmedLine) as unknown;
        flushPlainTextBuffer();
        appendOutputPartFromBlock(parts, parsedLine);
        continue;
      } catch {
        // 不是合法 JSON 行时，回退到普通文本解析
      }
    }

    plainTextBuffer = plainTextBuffer === '' ? line : `${plainTextBuffer}\n${line}`;
  }

  flushPlainTextBuffer();
}

function parseOpenClawJsonlContent(rawText: string): unknown[] | null {
  const trimmed = rawText.trim();
  if (trimmed === '') return null;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines.length === 0) return null;

  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      return null;
    }
  }
  return parsed;
}

function appendOutputPartFromBlock(parts: GenAiMessagePart[], block: unknown): void {
  if (typeof block === 'string') {
    appendTaggedOutputParts(parts, block);
    return;
  }

  if (!block || typeof block !== 'object') {
    parts.push({ type: 'text', content: safeJsonStringify(block) });
    return;
  }

  const b = block as Record<string, unknown>;
  const textVal = b.text !== undefined ? String(b.text) : undefined;
  const thinkingVal =
    b.thinking !== undefined
      ? String(b.thinking)
      : b.content !== undefined && b.type === 'thinking'
        ? String(b.content)
        : undefined;

  if ((b.type === 'text' || b.type === 'output_text') && textVal !== undefined) {
    appendTaggedOutputParts(parts, textVal);
  } else if (b.type === 'thinking' && thinkingVal !== undefined) {
    parts.push({ type: 'thinking', content: thinkingVal });
  } else if (
    (b.type === 'reasoning' || b.type === 'thinking' || b.thought === true) &&
    textVal !== undefined
  ) {
    parts.push({ type: 'thinking', content: textVal });
  } else if (b.type === 'tool_use' && b.id !== undefined) {
    parts.push({
      type: 'tool_call',
      id: String(b.id),
      name: typeof b.name === 'string' ? b.name : 'unknown',
      arguments: (b.input ?? b.arguments ?? {}) as Record<string, unknown>,
    });
  } else if (b.type === 'toolCall' && b.id !== undefined) {
    parts.push({
      type: 'tool_call',
      id: String(b.id),
      name: typeof b.name === 'string' ? b.name : 'unknown',
      arguments:
        typeof b.arguments === 'string'
          ? String(b.arguments)
          : ((b.arguments ?? {}) as Record<string, unknown>),
    });
  } else if (textVal !== undefined) {
    appendTaggedOutputParts(parts, textVal);
  } else {
    parts.push({ type: 'text', content: safeJsonStringify(block) });
  }
}

export function normalizeToGenAiOutputMessages(
  assistantMessage: unknown,
  finishReason?: string,
): GenAiChatMessage[] {
  if (assistantMessage == null) return [];

  const raw = assistantMessage as Record<string, unknown>;
  const role = typeof raw.role === 'string' ? raw.role : 'assistant';
  const parts: GenAiMessagePart[] = [];
  const content = raw.content;
  const toolCalls = raw.tool_calls as Array<Record<string, unknown>> | undefined;

  if (content === undefined || content === null) {
    // 仅 tool_calls 时可能无 content
  } else if (typeof content === 'string') {
    appendOutputPartsFromString(parts, content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      appendOutputPartFromBlock(parts, block);
    }
  } else {
    parts.push({ type: 'text', content: safeJsonStringify(content) });
  }

  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = (tc.function as Record<string, unknown>) ?? tc;
      const name = typeof fn.name === 'string' ? fn.name : 'unknown';
      const args = fn.arguments ?? (tc.arguments ?? {});
      parts.push({
        type: 'tool_call',
        id: typeof tc.id === 'string' ? tc.id : '',
        name,
        arguments: typeof args === 'string' ? args : (args as Record<string, unknown>),
      });
    }
  }

  if (parts.length === 0) parts.push({ type: 'text', content: '' });

  const msg: GenAiChatMessage = { role, parts };
  if (finishReason != null && finishReason !== '') {
    msg.finish_reason = finishReason;
  }
  return [msg];
}

/**
 * 构建单次 LLM 调用的完整 gen_ai.input.messages（OTel/Logfire 语义）：
 * 可选的 system + historyMessages 规范化 + 当前轮用户消息（prompt）。
 * 这样 Logfire 能正确解析多轮对话、工具调用、思考等为富文本。
 */
export function buildFullInputMessages(
  systemPrompt: string | undefined,
  historyMessages: unknown[] | undefined,
  currentPrompt: string,
): GenAiChatMessage[] {
  const out: GenAiChatMessage[] = [];

  const systemInstructions = buildSystemInstructions(systemPrompt);
  if (systemInstructions.length > 0) {
    out.push({
      role: 'system',
      parts: systemInstructions,
    });
  }

  if (Array.isArray(historyMessages) && historyMessages.length > 0) {
    out.push(...normalizeToGenAiInputMessages(historyMessages));
  }

  out.push({
    role: 'user',
    parts: [{ type: 'text', content: currentPrompt }],
  });

  return out;
}

/** 将 system prompt 规范化为可供 Logfire 解析的数组。 */
export function buildSystemInstructions(
  systemPrompt: string | undefined,
): SystemInstructionPart[] {
  if (typeof systemPrompt !== 'string') return [];
  const trimmedPrompt = systemPrompt.trim();
  if (trimmedPrompt === '') return [];
  return [{ type: 'text', content: trimmedPrompt }];
}

/** 基于当前轮输入基底与最新 assistant 输出构造根 span 的完整消息数组。 */
export function buildPydanticAiAllMessages(
  baseMessages: GenAiChatMessage[] | undefined,
  assistantMessages: GenAiChatMessage[],
): GenAiChatMessage[] {
  const normalizedBaseMessages = Array.isArray(baseMessages) ? baseMessages : [];
  if (assistantMessages.length === 0) return [...normalizedBaseMessages];
  return [...normalizedBaseMessages, ...assistantMessages];
}

/** 将 agent_end 的完整 messages 快照转为可供根/chat span 复用的消息数组。 */
export function buildMessagesFromConversationHistory(
  messages: unknown[] | undefined,
): GenAiChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return normalizeToGenAiInputMessages(messages, { toolResultRole: 'user' });
}

function isMessageEquivalent(left: GenAiChatMessage, right: GenAiChatMessage): boolean {
  return safeJsonStringify(left) === safeJsonStringify(right);
}

/** 从完整会话消息中切出当前 LLM 调用对应的输出片段。 */
export function extractConversationOutputMessages(
  fullConversationMessages: GenAiChatMessage[],
  inputMessages: GenAiChatMessage[],
): GenAiChatMessage[] {
  if (fullConversationMessages.length === 0) return [];
  const comparableInputMessages = inputMessages.filter(
    (message) => message.role !== 'system',
  );
  if (comparableInputMessages.length === 0) return [...fullConversationMessages];
  if (fullConversationMessages.length < comparableInputMessages.length) return [];

  const prefixMatches = comparableInputMessages.every((message, index) =>
    isMessageEquivalent(message, fullConversationMessages[index]),
  );
  if (!prefixMatches) return [...fullConversationMessages];

  return fullConversationMessages.slice(comparableInputMessages.length);
}

/** 将 assistantTexts 兜底转成一条 assistant 消息。 */
export function buildAssistantMessagesFromTexts(
  assistantTexts: string[] | undefined,
  finishReason?: string,
): GenAiChatMessage[] {
  if (!Array.isArray(assistantTexts) || assistantTexts.length === 0) return [];
  const parts: GenAiMessagePart[] = [];
  const combinedText = assistantTexts
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
    .trim();
  if (combinedText === '') return [];
  appendOutputPartsFromString(parts, combinedText);
  if (parts.length === 0) return [];
  const message: GenAiChatMessage = {
    role: 'assistant',
    parts,
  };
  if (finishReason != null && finishReason !== '') {
    message.finish_reason = finishReason;
  }
  return [message];
}

/** 提取最终回答正文，优先取最后一条 assistant 的 text part。 */
export function extractFinalResult(
  allMessages: GenAiChatMessage[],
): string | undefined {
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index];
    if (message.role !== 'assistant') continue;
    const textParts = message.parts
      .filter((part) => part.type === 'text' && typeof part.content === 'string')
      .map((part) => part.content?.trim() ?? '')
      .filter((content) => content !== '');
    if (textParts.length > 0) {
      return textParts.join('\n\n');
    }
  }
  return undefined;
}

/**
 * Logfire 用此 attribute 的 JSON schema 声明各 attribute 的类型；
 * 声明为 array 后，后端会把 JSON 字符串解析为数组再展示（LLM 面板等）。
 * @see https://github.com/pydantic/logfire
 */
export const LOGFIRE_JSON_SCHEMA_KEY = 'logfire.json_schema';

/**
 * 与官方 opentelemetry-instrumentation-google-genai 一致的 instrumentation scope 名称。
 * 使用此 scope 时，Logfire 后端会按 Google Gen AI 方式解析并展示 LLM 富文本面板。
 * @see https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/instrumentation-genai/opentelemetry-instrumentation-google-genai/src/opentelemetry/instrumentation/google_genai/otel_wrapper.py
 */
export const LOGFIRE_GENAI_COMPAT_SCOPE_NAME = 'opentelemetry.instrumentation.google_genai';

/** 与官方 Pydantic AI span 一致的 instrumentation scope 名称。 */
export const LOGFIRE_PYDANTIC_AI_SCOPE_NAME = 'pydantic-ai';

/** 将 schema properties 包装成 Logfire 期望的 JSON schema。 */
export function buildLogfireJsonSchema(
  properties: Record<string, JsonSchemaProperty>,
): string {
  return JSON.stringify({
    type: 'object',
    properties,
  });
}

/** chat span 的消息属性 schema。 */
export const GEN_AI_CHAT_ATTRIBUTES_SCHEMA_STRING = buildLogfireJsonSchema({
  'gen_ai.input.messages': { type: 'array' },
  'gen_ai.output.messages': { type: 'array' },
  'gen_ai.system_instructions': { type: 'array' },
});

/** 根 agent span 的 pydantic-ai 属性 schema。 */
export const PYDANTIC_AI_AGENT_ATTRIBUTES_SCHEMA_STRING = buildLogfireJsonSchema({
  'pydantic_ai.all_messages': { type: 'array' },
  'gen_ai.system_instructions': { type: 'array' },
});

/** tool span 的结构化参数/结果 schema。 */
export const TOOL_SPAN_ATTRIBUTES_SCHEMA_STRING = buildLogfireJsonSchema({
  tool_arguments: { type: 'object' },
  tool_response: { type: 'object' },
});

/**
 * Extract workspace name from a workspace directory path.
 * e.g., "/path/to/workspaces/chief-of-staff" -> "chief-of-staff"
 */
export function extractWorkspaceName(workspaceDir: string | undefined): string {
  if (!workspaceDir) return 'unknown';
  const parts = workspaceDir.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Generate a short unique ID for tool call correlation.
 * Uses timestamp + random suffix to avoid collisions without
 * pulling in a uuid dependency.
 */
export function generateCallId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/**
 * Extract error details in a structured format suitable for OTEL
 * exception semantic conventions.
 */
export function extractErrorDetails(error: unknown): {
  type: string;
  message: string;
  stacktrace: string;
} {
  if (error instanceof Error) {
    return {
      type: error.constructor.name || 'Error',
      message: error.message,
      stacktrace: error.stack ?? '',
    };
  }
  if (typeof error === 'string') {
    return { type: 'Error', message: error, stacktrace: '' };
  }
  return {
    type: 'Error',
    message: safeJsonStringify(error),
    stacktrace: '',
  };
}
