/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createNoopMeter,
  metrics,
  ProxyTracerProvider,
  trace,
} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {detectResources, envDetector, Resource} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';

import type {GoogleAuth} from 'google-auth-library';

export interface OtelExportersConfig {
  enableTracing?: boolean;
  enableMetrics?: boolean;
  enableLogging?: boolean;
  projectId?: string;
  auth?: GoogleAuth;
}

/**
 * Configuration hooks for OpenTelemetry setup.
 *
 * This interface defines the structure for configuring OpenTelemetry
 * components including span processors, metric readers, and log record processors.
 */
export interface OTelHooks {
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  logRecordProcessors?: LogRecordProcessor[];
}

/**
 * Sets up OTel providers if hooks for a given telemetry type were passed.
 *
 * Additionally adds generic OTLP exporters based on following env variables:
 * OTEL_EXPORTER_OTLP_ENDPOINT
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
 * OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
 * OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
 * See https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/
 * for how they are used.
 *
 * If a provider for a specific telemetry type was already globally set -
 * this function will not override it or register more exporters.
 *
 * @experimental (Experimental, subject to change)
 *
 * @param otelHooksToSetup per-telemetry-type processors and readers to be added
 * to OTel providers. If no hooks for a specific telemetry type are passed -
 * provider will not be set.
 * @param otelResource OTel resource to use in providers.
 * If empty - default OTel resource detection will be used.
 */
export function maybeSetOtelProviders(
  otelHooksToSetup: OTelHooks[] = [],
  otelResource?: Resource,
): void {
  const tracerAlreadySet = isTracerProviderRegistered();
  const meterAlreadySet = isMeterProviderRegistered();
  const loggerAlreadySet = isLoggerProviderRegistered();

  if (tracerAlreadySet && meterAlreadySet && loggerAlreadySet) {
    return;
  }

  const exportersConfig = getOtelExportersConfig();
  if (tracerAlreadySet) {
    exportersConfig.enableTracing = false;
  }
  if (meterAlreadySet) {
    exportersConfig.enableMetrics = false;
  }
  if (loggerAlreadySet) {
    exportersConfig.enableLogging = false;
  }

  const resource = otelResource || getOtelResource();
  const allHooks = [...otelHooksToSetup, getOtelExporters(exportersConfig)];
  const spanProcessors = allHooks.flatMap(
    (hooks) => hooks.spanProcessors || [],
  );
  const metricReaders = allHooks.flatMap((hooks) => hooks.metricReaders || []);
  const logRecordProcessors = allHooks.flatMap(
    (hooks) => hooks.logRecordProcessors || [],
  );

  if (!tracerAlreadySet && spanProcessors.length > 0) {
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors,
    });
    tracerProvider.register();
  }

  if (!meterAlreadySet && metricReaders.length > 0) {
    const meterProvider = new MeterProvider({
      readers: metricReaders,
      resource,
    });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  if (!loggerAlreadySet && logRecordProcessors.length > 0) {
    const loggerProvider = new LoggerProvider({
      resource,
      processors: logRecordProcessors,
    });
    // logs is experimental, reference to https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_api-logs.html#alpha-software---use-at-your-own-risk
    logs.setGlobalLoggerProvider(loggerProvider);
  }
}

/**
 * Gets the OTel resource with environment variable detection.
 *
 * The resource detection populates resource labels from
 * environment variables like OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
 *
 * @returns A Resource object with detected attributes
 */
function getOtelResource(): Resource {
  return detectResources({
    detectors: [envDetector],
  });
}

/**
 * Gets OTel exporters configuration based on environment variables.
 *
 * @returns OtelExportersConfig with flags based on environment variables
 */
function getOtelExportersConfig(): OtelExportersConfig {
  return {
    enableTracing: !!(
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ),
    enableMetrics: !!(
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    ),
    enableLogging: !!(
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    ),
  };
}

/**
 * Gets OTel exporters based on configuration.
 *
 * @param config Configuration for which exporters to enable
 * @returns OTelHooks containing configured exporters
 */
function getOtelExporters(config = getOtelExportersConfig()): OTelHooks {
  const {enableTracing, enableMetrics, enableLogging} = config;
  return {
    spanProcessors: enableTracing
      ? [new BatchSpanProcessor(new OTLPTraceExporter())]
      : [],
    metricReaders: enableMetrics
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
          }),
        ]
      : [],
    logRecordProcessors: enableLogging
      ? [new BatchLogRecordProcessor({exporter: new OTLPLogExporter()})]
      : [],
  };
}

/**
 * Detects whether a global tracer provider has already been registered.
 *
 * Handles cases where trace.getTracerProvider returns undefined (e.g. in tests)
 * or a ProxyTracerProvider delegating to a NoopTracerProvider, including when
 * minification mangles class names.
 */
function isTracerProviderRegistered(): boolean {
  const provider = trace.getTracerProvider?.();
  if (!provider) {
    return false;
  }
  const noopDelegate =
    typeof ProxyTracerProvider === 'function'
      ? new ProxyTracerProvider()?.getDelegate?.()
      : undefined;
  const getDelegate = (
    provider as {getDelegate?: () => {constructor?: {name?: string}}}
  ).getDelegate;
  if (typeof getDelegate === 'function') {
    const delegate = getDelegate.call(provider);
    if (!delegate) {
      return false;
    }
    if (noopDelegate && delegate === noopDelegate) {
      return false;
    }
    return delegate.constructor?.name !== 'NoopTracerProvider';
  }
  if (noopDelegate && provider === noopDelegate) {
    return false;
  }
  return (
    provider.constructor?.name !== 'ProxyTracerProvider' &&
    provider.constructor?.name !== 'NoopTracerProvider'
  );
}

/**
 * Detects whether a global meter provider has already been registered.
 *
 * Handles cases where metrics.getMeterProvider returns undefined (e.g. in tests)
 * or the default NoopMeterProvider, including when minification mangles class names.
 */
function isMeterProviderRegistered(): boolean {
  const provider = metrics.getMeterProvider?.();
  if (!provider) {
    return false;
  }
  const noopMeter =
    typeof createNoopMeter === 'function' ? createNoopMeter() : undefined;
  if (
    noopMeter &&
    typeof (provider as {getMeter?: (name: string) => unknown}).getMeter ===
      'function'
  ) {
    if (provider.getMeter('adk') === noopMeter) {
      return false;
    }
  }
  return provider.constructor?.name !== 'NoopMeterProvider';
}

/**
 * Detects whether a global logger provider has already been registered.
 *
 * Handles cases where logs.getLoggerProvider returns undefined (e.g. in tests)
 * or the default ProxyLoggerProvider/NoopLoggerProvider, including when
 * minification mangles class names.
 */
function isLoggerProviderRegistered(): boolean {
  const provider = logs.getLoggerProvider?.() as
    | {
        _getDelegate?: () => unknown;
        _delegate?: unknown;
        constructor?: {name?: string};
      }
    | undefined;
  if (!provider) {
    return false;
  }
  if (typeof provider._getDelegate === 'function') {
    return provider._delegate !== undefined;
  }
  return (
    provider.constructor?.name !== 'ProxyLoggerProvider' &&
    provider.constructor?.name !== 'NoopLoggerProvider'
  );
}
