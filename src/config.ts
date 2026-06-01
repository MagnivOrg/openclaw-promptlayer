// SPDX-License-Identifier: MIT

export interface BatchConfig {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMs: number;
}

export interface PromptLayerPluginConfig {
  apiKey: string;
  endpoint: string;
  environment: string;
  serviceName: string;
  providerName: string;
  providerNameMap: Record<string, string>;
  captureToolInput: boolean;
  captureToolOutput: boolean;
  toolInputMaxLength: number;
  toolOutputMaxLength: number;
  captureMessageContent: boolean;
  captureHistoryMessages: boolean;
  historyMessagesMaxLength: number;
  redactSecrets: boolean;
  resourceAttributes: Record<string, string>;
  spanProcessorType: 'batch' | 'simple';
  batchConfig: BatchConfig;
}

const DEFAULTS: PromptLayerPluginConfig = {
  apiKey: '',
  endpoint: 'https://api.promptlayer.com/v1/traces',
  environment: 'development',
  serviceName: 'openclaw-agent',
  providerName: '',
  providerNameMap: {},
  captureToolInput: true,
  captureToolOutput: false,
  toolInputMaxLength: 2048,
  toolOutputMaxLength: 512,
  captureMessageContent: false,
  captureHistoryMessages: false,
  historyMessagesMaxLength: 16384,
  redactSecrets: true,
  resourceAttributes: {},
  spanProcessorType: 'batch',
  batchConfig: {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMs: 5000,
  },
};

export function resolveConfig(
  userConfig: Record<string, unknown> | undefined,
): PromptLayerPluginConfig {
  const raw = userConfig ?? {};
  const batchConfigRaw = (raw.batchConfig as Record<string, unknown>) ?? {};

  return {
    apiKey: asString(raw.apiKey) || process.env.PROMPTLAYER_API_KEY || '',
    endpoint: asString(raw.endpoint) || DEFAULTS.endpoint,
    environment:
      asString(raw.environment) ||
      process.env.PROMPTLAYER_ENVIRONMENT ||
      DEFAULTS.environment,
    serviceName: asString(raw.serviceName) || DEFAULTS.serviceName,
    providerName:
      asString(raw.providerName) ||
      process.env.PROMPTLAYER_PROVIDER_NAME ||
      DEFAULTS.providerName,
    providerNameMap:
      asStringRecord(raw.providerNameMap) ?? DEFAULTS.providerNameMap,
    captureToolInput: asBool(raw.captureToolInput) ?? DEFAULTS.captureToolInput,
    captureToolOutput:
      asBool(raw.captureToolOutput) ?? DEFAULTS.captureToolOutput,
    toolInputMaxLength:
      asInt(raw.toolInputMaxLength) ?? DEFAULTS.toolInputMaxLength,
    toolOutputMaxLength:
      asInt(raw.toolOutputMaxLength) ?? DEFAULTS.toolOutputMaxLength,
    captureMessageContent:
      asBool(raw.captureMessageContent) ?? DEFAULTS.captureMessageContent,
    captureHistoryMessages:
      asBool(raw.captureHistoryMessages) ?? DEFAULTS.captureHistoryMessages,
    historyMessagesMaxLength:
      asInt(raw.historyMessagesMaxLength) ?? DEFAULTS.historyMessagesMaxLength,
    redactSecrets: asBool(raw.redactSecrets) ?? DEFAULTS.redactSecrets,
    resourceAttributes:
      asStringRecord(raw.resourceAttributes) ?? DEFAULTS.resourceAttributes,
    spanProcessorType:
      asEnum(raw.spanProcessorType, ['batch', 'simple']) ??
      DEFAULTS.spanProcessorType,
    batchConfig: {
      maxQueueSize:
        asInt(batchConfigRaw.maxQueueSize) ?? DEFAULTS.batchConfig.maxQueueSize,
      maxExportBatchSize:
        asInt(batchConfigRaw.maxExportBatchSize) ??
        DEFAULTS.batchConfig.maxExportBatchSize,
      scheduledDelayMs:
        asInt(batchConfigRaw.scheduledDelayMs) ??
        DEFAULTS.batchConfig.scheduledDelayMs,
    },
  };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function asEnum<T extends string>(
  v: unknown,
  allowed: T[],
): T | undefined {
  return typeof v === 'string' && (allowed as string[]).includes(v)
    ? (v as T)
    : undefined;
}

function asStringRecord(
  v: unknown,
): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.every(([, val]) => typeof val === 'string')) {
    return v as Record<string, string>;
  }
  return undefined;
}
