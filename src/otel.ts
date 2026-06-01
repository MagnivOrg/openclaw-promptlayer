// SPDX-License-Identifier: MIT

import type { Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import type { PromptLayerPluginConfig } from './config.js';
import { INSTRUMENTATION_SCOPE_NAME } from './util.js';

export interface PromptLayerOtel {
  getTracer(): Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PromptLayerOtelLogger {
  warn(msg: string): void;
}

let activeProvider: BasicTracerProvider | null = null;

export function getPromptLayerTracer(): Tracer {
  if (!activeProvider) {
    throw new Error('openclaw-promptlayer: OTEL tracer provider is not initialized');
  }
  return activeProvider.getTracer(INSTRUMENTATION_SCOPE_NAME, '1.0.0');
}

function withExportLogging(
  exporter: SpanExporter,
  logger?: PromptLayerOtelLogger,
): SpanExporter {
  let exportQueue = Promise.resolve();

  const logResult = (spans: ReadableSpan[], result: ExportResult): void => {
    if (result.code === ExportResultCode.SUCCESS) return;
    const errorMessage =
      result.error instanceof Error
        ? result.error.message
        : result.error
          ? String(result.error)
          : 'unknown error';
    logger?.warn(
      `PromptLayer trace export failed (${spans.length} span(s)): ${errorMessage}`,
    );
  };

  return {
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void) {
      const exportOperation = (): Promise<ExportResult> =>
        new Promise((resolve) => {
          exporter.export(spans, resolve);
        });

      const queuedExport = exportQueue.then(exportOperation, exportOperation);
      exportQueue = queuedExport.then(
        () => undefined,
        () => undefined,
      );

      queuedExport.then((result) => {
        logResult(spans, result);
        resultCallback(result);
      }).catch((error: unknown) => {
        const result = {
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        logResult(spans, result);
        resultCallback(result);
      });
    },
    shutdown: () => exportQueue.then(() => exporter.shutdown()),
    forceFlush: () =>
      exportQueue.then(() => exporter.forceFlush?.() ?? Promise.resolve()),
  };
}

export function initializeOtel(
  config: PromptLayerPluginConfig,
  logger?: PromptLayerOtelLogger,
): PromptLayerOtel {
  if (!config.apiKey) {
    throw new Error(
      'openclaw-promptlayer: PROMPTLAYER_API_KEY is required. ' +
        'Set it as an environment variable or in plugin config as apiKey.',
    );
  }

  const traceExporter = withExportLogging(new OTLPTraceExporter({
    url: config.endpoint,
    headers: { 'X-API-KEY': config.apiKey },
  }), logger);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.environment,
    ...config.resourceAttributes,
  });

  const spanProcessor =
    config.spanProcessorType === 'simple'
      ? new SimpleSpanProcessor(traceExporter)
      : new BatchSpanProcessor(traceExporter, {
          maxQueueSize: config.batchConfig.maxQueueSize,
          maxExportBatchSize: config.batchConfig.maxExportBatchSize,
          scheduledDelayMillis: config.batchConfig.scheduledDelayMs,
        });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  });
  activeProvider = provider;

  return {
    getTracer: () => provider.getTracer(INSTRUMENTATION_SCOPE_NAME, '1.0.0'),
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      if (activeProvider === provider) {
        activeProvider = null;
      }
    },
  };
}
