import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from './config.js';

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns PromptLayer defaults when no config is provided', () => {
    const config = resolveConfig(undefined);
    expect(config.apiKey).toBe('');
    expect(config.endpoint).toBe('https://api.promptlayer.com/v1/traces');
    expect(config.serviceName).toBe('openclaw-agent');
    expect(config.environment).toBe('development');
    expect(config.captureToolInput).toBe(true);
    expect(config.captureToolOutput).toBe(false);
    expect(config.captureMessageContent).toBe(false);
    expect(config.redactSecrets).toBe(true);
    expect(config.spanProcessorType).toBe('batch');
  });

  it('reads PROMPTLAYER_API_KEY from env', () => {
    process.env.PROMPTLAYER_API_KEY = 'test-token-123';
    const config = resolveConfig({});
    expect(config.apiKey).toBe('test-token-123');
  });

  it('explicit apiKey overrides env vars', () => {
    process.env.PROMPTLAYER_API_KEY = 'env-token';
    const config = resolveConfig({ apiKey: 'explicit-token' });
    expect(config.apiKey).toBe('explicit-token');
  });

  it('reads PROMPTLAYER_ENVIRONMENT from env', () => {
    process.env.PROMPTLAYER_ENVIRONMENT = 'production';
    const config = resolveConfig({});
    expect(config.environment).toBe('production');
  });

  it('falls back for invalid enum values', () => {
    const config = resolveConfig({
      spanProcessorType: 'turbo',
    });
    expect(config.spanProcessorType).toBe('batch');
  });

  it('accepts valid enum values', () => {
    const config = resolveConfig({
      spanProcessorType: 'simple',
    });
    expect(config.spanProcessorType).toBe('simple');
  });

  it('merges batchConfig with defaults', () => {
    const config = resolveConfig({
      batchConfig: { maxQueueSize: 4096 },
    });
    expect(config.batchConfig.maxQueueSize).toBe(4096);
    expect(config.batchConfig.maxExportBatchSize).toBe(512);
    expect(config.batchConfig.scheduledDelayMs).toBe(5000);
  });

  it('accepts resourceAttributes as string record', () => {
    const config = resolveConfig({
      resourceAttributes: { 'custom.team': 'platform', 'custom.version': '2.0' },
    });
    expect(config.resourceAttributes).toEqual({
      'custom.team': 'platform',
      'custom.version': '2.0',
    });
  });
});
