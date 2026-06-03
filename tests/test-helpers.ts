// SPDX-License-Identifier: MIT
/**
 * Shared test helpers for hook handler tests.
 *
 * Provides mock OTEL spans, tracers, and a default config factory
 * so each test file stays focused on handler behavior.
 */

import { vi } from 'vitest';
import type { Span, Context, SpanContext } from '@opentelemetry/api';
import type { PromptLayerPluginConfig } from '../src/config.js';

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

/** Create a minimal PromptLayerPluginConfig with sensible test defaults. */
export function createTestConfig(
  overrides?: Partial<PromptLayerPluginConfig>,
): PromptLayerPluginConfig {
  return {
    apiKey: 'test-token',
    endpoint: 'https://api.promptlayer.com/v1/traces',
    environment: 'test',
    serviceName: 'openclaw-agent',
    providerName: '',
    providerNameMap: {},
    resourceAttributes: {},
    spanProcessorType: 'batch',
    batchConfig: {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMs: 5000,
    },
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
