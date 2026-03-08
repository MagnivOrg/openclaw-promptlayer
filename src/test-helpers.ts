// SPDX-License-Identifier: MIT
/**
 * Shared test helpers for hook handler tests.
 *
 * Provides mock OTEL spans, tracers, and a default config factory
 * so each test file stays focused on handler behavior.
 */

import { vi } from 'vitest';
import type { Span, Context, SpanContext } from '@opentelemetry/api';
import type { LogfirePluginConfig } from './config.js';

/** Create a mock OTEL Span with all methods as vi.fn(). */
export function mockSpan(overrides?: Partial<SpanContext>): Span {
  const spanCtx: SpanContext = {
    traceId: overrides?.traceId ?? 'abc123def456abc123def456abc123de',
    spanId: overrides?.spanId ?? '1234567890abcdef',
    traceFlags: overrides?.traceFlags ?? 1,
  };

  return {
    end: vi.fn(),
    spanContext: vi.fn(() => spanCtx),
    setAttribute: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    addEvent: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    recordException: vi.fn().mockReturnThis(),
    isRecording: vi.fn(() => true),
    updateName: vi.fn().mockReturnThis(),
    setAttributes: vi.fn().mockReturnThis(),
  } as unknown as Span;
}

/** Create a mock OTEL Context. */
export function mockContext(): Context {
  return {} as Context;
}

/**
 * Create a minimal LogfirePluginConfig with sensible test defaults.
 * All capture flags are off by default to keep tests explicit.
 */
export function createTestConfig(
  overrides?: Partial<LogfirePluginConfig>,
): LogfirePluginConfig {
  return {
    token: 'test-token',
    projectUrl: '',
    region: 'us',
    environment: 'test',
    serviceName: 'openclaw-agent',
    providerName: '',
    providerNameMap: {},
    captureToolInput: false,
    captureToolOutput: false,
    toolInputMaxLength: 2048,
    toolOutputMaxLength: 512,
    captureStackTraces: true,
    captureMessageContent: false,
    captureHistoryMessages: false,
    historyMessagesMaxLength: 16384,
    captureToolDefinitions: false,
    redactSecrets: true,
    distributedTracing: {
      enabled: false,
      injectIntoCommands: true,
      extractFromWebhooks: true,
      urlPatterns: ['*'],
    },
    enableMetrics: false,
    metricsIntervalMs: 60000,
    enableTraceLinks: false,
    logLevel: 'info',
    resourceAttributes: {},
    spanProcessorType: 'batch',
    batchConfig: {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMs: 5000,
    },
    useGenAiCompatibilityScope: true,
    ...overrides,
  };
}

/** Create a mock logger matching the Logger interface. */
export function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Setup the OTEL trace mock. Call this in vi.mock('@opentelemetry/api', ...).
 * Returns a factory that creates mock tracers whose startSpan returns
 * the provided mock span.
 */
export function createMockTracer(spanToReturn: Span) {
  return {
    startSpan: vi.fn(() => spanToReturn),
  };
}
