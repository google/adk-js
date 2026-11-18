/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OTelHooks, maybeSetOtelProviders} from '@google/adk';
import {
  type Meter,
  MeterProvider as IMeterProvider,
  ProxyTracerProvider,
  TracerProvider,
  createNoopMeter,
  metrics,
  trace,
} from '@opentelemetry/api';
import {LoggerProvider as ILoggerProvider, logs} from '@opentelemetry/api-logs';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {LoggerProvider} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
  vi.resetModules();
});
// Mock OpenTelemetry modules
vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');
vi.mock('@opentelemetry/sdk-trace-node');
vi.mock('@opentelemetry/sdk-metrics');
vi.mock('@opentelemetry/sdk-logs');
vi.mock('@opentelemetry/api');
vi.mock('@opentelemetry/api-logs');
vi.mock('../../src/utils/logger.js');

describe('maybeSetOtelProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test initializing correct providers in maybeSetOtelProviders
   * when providing OTel env variables.
   *
   * This test is parameterized to test different combinations of env variables
   * and verify that the correct providers are set up.
   */
  const testCases: Array<{
    envVars: Record<string, string>;
    shouldSetupTrace: boolean;
    shouldSetupMetrics: boolean;
    shouldSetupLogs: boolean;
    description: string;
  }> = [
    {
      envVars: {OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'some-endpoint'},
      shouldSetupTrace: true,
      shouldSetupMetrics: false,
      shouldSetupLogs: false,
      description:
        'should set up trace provider when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set',
    },
    {
      envVars: {OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'some-endpoint'},
      shouldSetupTrace: false,
      shouldSetupMetrics: true,
      shouldSetupLogs: false,
      description:
        'should set up metrics provider when OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set',
    },
    {
      envVars: {OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'some-endpoint'},
      shouldSetupTrace: false,
      shouldSetupMetrics: false,
      shouldSetupLogs: true,
      description:
        'should set up logs provider when OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set',
    },
    {
      envVars: {OTEL_EXPORTER_OTLP_ENDPOINT: 'some-endpoint'},
      shouldSetupTrace: true,
      shouldSetupMetrics: true,
      shouldSetupLogs: true,
      description:
        'should set up all providers when OTEL_EXPORTER_OTLP_ENDPOINT is set',
    },
  ];

  testCases.forEach(
    ({
      envVars,
      shouldSetupTrace,
      shouldSetupMetrics,
      shouldSetupLogs,
      description,
    }) => {
      it(description, async () => {
        // Arrange
        Object.entries(envVars).forEach(([key, value]) => {
          vi.stubEnv(key, value);
        });

        const traceProviderRegisterMock = vi.mocked(
          NodeTracerProvider.prototype.register,
        );
        const meterProviderMock = vi.mocked(metrics.setGlobalMeterProvider);
        const logsProviderMock = vi.mocked(logs.setGlobalLoggerProvider);

        // Act
        await maybeSetOtelProviders();

        // Assert
        expect(traceProviderRegisterMock).toHaveBeenCalledTimes(
          shouldSetupTrace ? 1 : 0,
        );
        expect(meterProviderMock).toHaveBeenCalledTimes(
          shouldSetupMetrics ? 1 : 0,
        );
        expect(logsProviderMock).toHaveBeenCalledTimes(shouldSetupLogs ? 1 : 0);
      });
    },
  );

  it('should not set up any providers when no env vars are set', async () => {
    // Act
    await maybeSetOtelProviders();

    // Assert
    expect(NodeTracerProvider.prototype.register).not.toHaveBeenCalled();
    expect(metrics.setGlobalMeterProvider).not.toHaveBeenCalled();
    expect(logs.setGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  it('should set up providers with custom hooks', async () => {
    // Arrange
    const mockSpanProcessor = {
      forceFlush: vi.fn(),
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn(),
    };
    const mockMetricReader = {
      forceFlush: vi.fn(),
      setMetricProducer: vi.fn(),
      selectAggregation: vi.fn(),
      selectAggregationTemporality: vi.fn(),
      selectCardinalityLimit: vi.fn(),
      collect: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as MetricReader;
    const mockLogProcessor = {
      forceFlush: vi.fn(),
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn(),
      onEmit: vi.fn(),
    };

    const hooks: OTelHooks = {
      spanProcessors: [mockSpanProcessor],
      metricReaders: [mockMetricReader],
      logRecordProcessors: [mockLogProcessor],
    };

    // Act
    await maybeSetOtelProviders([hooks]);

    // Assert
    expect(NodeTracerProvider.prototype.register).toHaveBeenCalledTimes(1);
    expect(metrics.setGlobalMeterProvider).toHaveBeenCalledTimes(1);
    expect(logs.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
  });

  it('detects resource attributes from OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES', async () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'my-test-service');
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', 'custom.key=custom-val,env=test');

    const mockSpanProcessor = {
      forceFlush: vi.fn(),
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn(),
    };

    await maybeSetOtelProviders([{spanProcessors: [mockSpanProcessor]}]);

    expect(NodeTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({
          attributes: expect.objectContaining({
            'service.name': 'my-test-service',
            'custom.key': 'custom-val',
            env: 'test',
          }),
        }),
      }),
    );
  });

  class RegisteredTracerProvider implements TracerProvider {
    getTracer = vi.fn();
  }

  class RegisteredMeterProvider implements IMeterProvider {
    getMeter = vi.fn();
  }

  class RegisteredLoggerProvider implements ILoggerProvider {
    getLogger = vi.fn();
  }

  describe('registered global provider skipping', () => {
    afterEach(() => {
      vi.mocked(trace.getTracerProvider).mockReset();
      vi.mocked(metrics.getMeterProvider).mockReset();
      vi.mocked(logs.getLoggerProvider).mockReset();
      vi.mocked(ProxyTracerProvider).mockReset();
      vi.mocked(createNoopMeter).mockReset();
    });

    it('skips creating and registering trace provider and exporter when global tracer provider is already registered', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
      vi.mocked(trace.getTracerProvider).mockReturnValue(
        new RegisteredTracerProvider(),
      );

      await maybeSetOtelProviders();

      expect(NodeTracerProvider).not.toHaveBeenCalled();
      expect(NodeTracerProvider.prototype.register).not.toHaveBeenCalled();
      expect(OTLPTraceExporter).not.toHaveBeenCalled();

      expect(MeterProvider).toHaveBeenCalledTimes(1);
      expect(metrics.setGlobalMeterProvider).toHaveBeenCalledTimes(1);
      expect(OTLPMetricExporter).toHaveBeenCalledTimes(1);
      expect(PeriodicExportingMetricReader).toHaveBeenCalledTimes(1);

      expect(LoggerProvider).toHaveBeenCalledTimes(1);
      expect(logs.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
      expect(OTLPLogExporter).toHaveBeenCalledTimes(1);
    });

    it('skips creating and registering meter provider and exporter when global meter provider is already registered', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
      vi.mocked(metrics.getMeterProvider).mockReturnValue(
        new RegisteredMeterProvider(),
      );

      await maybeSetOtelProviders();

      expect(MeterProvider).not.toHaveBeenCalled();
      expect(metrics.setGlobalMeterProvider).not.toHaveBeenCalled();
      expect(OTLPMetricExporter).not.toHaveBeenCalled();
      expect(PeriodicExportingMetricReader).not.toHaveBeenCalled();

      expect(NodeTracerProvider).toHaveBeenCalledTimes(1);
      expect(NodeTracerProvider.prototype.register).toHaveBeenCalledTimes(1);
      expect(OTLPTraceExporter).toHaveBeenCalledTimes(1);

      expect(LoggerProvider).toHaveBeenCalledTimes(1);
      expect(logs.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
      expect(OTLPLogExporter).toHaveBeenCalledTimes(1);
    });

    it('skips creating and registering logger provider and exporter when global logger provider is already registered', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
      vi.mocked(logs.getLoggerProvider).mockReturnValue(
        new RegisteredLoggerProvider(),
      );

      await maybeSetOtelProviders();

      expect(LoggerProvider).not.toHaveBeenCalled();
      expect(logs.setGlobalLoggerProvider).not.toHaveBeenCalled();
      expect(OTLPLogExporter).not.toHaveBeenCalled();

      expect(NodeTracerProvider).toHaveBeenCalledTimes(1);
      expect(NodeTracerProvider.prototype.register).toHaveBeenCalledTimes(1);
      expect(OTLPTraceExporter).toHaveBeenCalledTimes(1);

      expect(MeterProvider).toHaveBeenCalledTimes(1);
      expect(metrics.setGlobalMeterProvider).toHaveBeenCalledTimes(1);
      expect(OTLPMetricExporter).toHaveBeenCalledTimes(1);
      expect(PeriodicExportingMetricReader).toHaveBeenCalledTimes(1);
    });

    it('skips all exporter and provider creation when all three global providers are already registered', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
      vi.mocked(trace.getTracerProvider).mockReturnValue(
        new RegisteredTracerProvider(),
      );
      vi.mocked(metrics.getMeterProvider).mockReturnValue(
        new RegisteredMeterProvider(),
      );
      vi.mocked(logs.getLoggerProvider).mockReturnValue(
        new RegisteredLoggerProvider(),
      );

      await maybeSetOtelProviders();

      expect(NodeTracerProvider).not.toHaveBeenCalled();
      expect(NodeTracerProvider.prototype.register).not.toHaveBeenCalled();
      expect(OTLPTraceExporter).not.toHaveBeenCalled();

      expect(MeterProvider).not.toHaveBeenCalled();
      expect(metrics.setGlobalMeterProvider).not.toHaveBeenCalled();
      expect(OTLPMetricExporter).not.toHaveBeenCalled();
      expect(PeriodicExportingMetricReader).not.toHaveBeenCalled();

      expect(LoggerProvider).not.toHaveBeenCalled();
      expect(logs.setGlobalLoggerProvider).not.toHaveBeenCalled();
      expect(OTLPLogExporter).not.toHaveBeenCalled();
    });

    it('detects registered tracer provider via ProxyTracerProvider delegate', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
      const proxyWithDelegate = {
        getDelegate: () => new RegisteredTracerProvider(),
        getTracer: vi.fn(),
        constructor: {name: 'ProxyTracerProvider'},
      };
      vi.mocked(trace.getTracerProvider).mockReturnValue(
        proxyWithDelegate as unknown as TracerProvider,
      );

      await maybeSetOtelProviders();

      expect(NodeTracerProvider).not.toHaveBeenCalled();
      expect(NodeTracerProvider.prototype.register).not.toHaveBeenCalled();
      expect(OTLPTraceExporter).not.toHaveBeenCalled();
    });

    it('registers providers when default providers have minified constructor names', async () => {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');

      const noopDelegate = {
        constructor: {},
      };
      Object.defineProperty(noopDelegate.constructor, 'name', {value: 'a'});
      const mockProxy = {
        getDelegate: () => noopDelegate,
      };
      vi.mocked(ProxyTracerProvider).mockImplementation(function () {
        return mockProxy as unknown as ProxyTracerProvider;
      });
      vi.mocked(trace.getTracerProvider).mockReturnValue(
        mockProxy as unknown as TracerProvider,
      );

      const noopMeter = {};
      vi.mocked(createNoopMeter).mockReturnValue(noopMeter as unknown as Meter);
      vi.mocked(metrics.getMeterProvider).mockReturnValue({
        getMeter: () => noopMeter,
        constructor: {name: 'b'},
      } as unknown as IMeterProvider);

      vi.mocked(logs.getLoggerProvider).mockReturnValue({
        _getDelegate: () => ({}),
        _delegate: undefined,
        constructor: {name: 'c'},
      } as unknown as ILoggerProvider);

      await maybeSetOtelProviders();

      expect(NodeTracerProvider).toHaveBeenCalledTimes(1);
      expect(NodeTracerProvider.prototype.register).toHaveBeenCalledTimes(1);
      expect(OTLPTraceExporter).toHaveBeenCalledTimes(1);

      expect(MeterProvider).toHaveBeenCalledTimes(1);
      expect(metrics.setGlobalMeterProvider).toHaveBeenCalledTimes(1);
      expect(OTLPMetricExporter).toHaveBeenCalledTimes(1);
      expect(PeriodicExportingMetricReader).toHaveBeenCalledTimes(1);

      expect(LoggerProvider).toHaveBeenCalledTimes(1);
      expect(logs.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
      expect(OTLPLogExporter).toHaveBeenCalledTimes(1);
    });
  });
});
