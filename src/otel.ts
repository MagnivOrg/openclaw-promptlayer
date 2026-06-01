// SPDX-License-Identifier: MIT

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import type { PromptLayerPluginConfig } from './config.js';

export function initializeOtel(config: PromptLayerPluginConfig): NodeSDK {
  if (!config.apiKey) {
    throw new Error(
      'openclaw-promptlayer: PROMPTLAYER_API_KEY is required. ' +
        'Set it as an environment variable or in plugin config as apiKey.',
    );
  }

  const traceExporter = new OTLPTraceExporter({
    url: config.endpoint,
    headers: { 'X-API-KEY': config.apiKey },
  });

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

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
  });
  sdk.start();
  return sdk;
}
