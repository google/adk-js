/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


import {maybeSetOtelProviders} from '../../src/telemetry/setup.js';
import type {OTelHooks} from '../../src/telemetry/setup.js';
import {trace} from '@opentelemetry/api';
import {metrics} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';

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
      envVars: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'some-endpoint' },
      shouldSetupTrace: true,
      shouldSetupMetrics: false,
      shouldSetupLogs: false,
      description: 'should set up trace provider when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set',
    },
    {
      envVars: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'some-endpoint' },
      shouldSetupTrace: false,
      shouldSetupMetrics: true,
      shouldSetupLogs: false,
      description: 'should set up metrics provider when OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set',
    },
    {
      envVars: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'some-endpoint' },
      shouldSetupTrace: false,
      shouldSetupMetrics: false,
      shouldSetupLogs: true,
      description: 'should set up logs provider when OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is set',
    },
    {
      envVars: { OTEL_EXPORTER_OTLP_ENDPOINT: 'some-endpoint' },
      shouldSetupTrace: true,
      shouldSetupMetrics: true,
      shouldSetupLogs: true,
      description: 'should set up all providers when OTEL_EXPORTER_OTLP_ENDPOINT is set',
    },
  ];

  testCases.forEach(({ envVars, shouldSetupTrace, shouldSetupMetrics, shouldSetupLogs, description }) => {
    it(description, async () => {
      // Arrange
      Object.entries(envVars).forEach(([key, value]) => {
        vi.stubEnv(key, value);
      });

      const traceProviderMock = vi.mocked(trace.setGlobalTracerProvider);
      const meterProviderMock = vi.mocked(metrics.setGlobalMeterProvider);
      const logsProviderMock = vi.mocked(logs.setGlobalLoggerProvider);

      // Act
      await maybeSetOtelProviders();

      // Assert
      expect(traceProviderMock).toHaveBeenCalledTimes(shouldSetupTrace ? 1 : 0);
      expect(meterProviderMock).toHaveBeenCalledTimes(shouldSetupMetrics ? 1 : 0);
      expect(logsProviderMock).toHaveBeenCalledTimes(shouldSetupLogs ? 1 : 0);
    });
  });

  it('should not set up any providers when no env vars are set', async () => {
    // Act
    await maybeSetOtelProviders();

    // Assert
    expect(trace.setGlobalTracerProvider).not.toHaveBeenCalled();
    expect(metrics.setGlobalMeterProvider).not.toHaveBeenCalled();
    expect(logs.setGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  it('should set up providers with custom hooks', async () => {
    // Arrange
    const mockSpanProcessor = { forceFlush: vi.fn() };
    const mockMetricReader = { forceFlush: vi.fn() };
    const mockLogProcessor = { forceFlush: vi.fn() };
    
    const hooks: OTelHooks = {
      spanProcessors: [mockSpanProcessor],
      metricReaders: [mockMetricReader],
      logRecordProcessors: [mockLogProcessor],
    };

    // Act
    await maybeSetOtelProviders([hooks]);

    // Assert
    expect(trace.setGlobalTracerProvider).toHaveBeenCalledTimes(1);
    expect(metrics.setGlobalMeterProvider).toHaveBeenCalledTimes(1);
    expect(logs.setGlobalLoggerProvider).toHaveBeenCalledTimes(1);
  });
});