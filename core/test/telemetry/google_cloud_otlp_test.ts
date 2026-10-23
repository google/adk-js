/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {getGcpExporters} from '../../src/telemetry/google_cloud.js';
import {logger} from '../../src/utils/logger.js';

interface ExporterConfig {
  url?: string;
  headers?: () => Promise<Record<string, string>>;
}

const CREDENTIAL_ERROR_TEXT = 'refresh token secret-token-1 was revoked';

const state = vi.hoisted(() => ({
  failCredentials: false,
  traceConfigs: [] as ExporterConfig[],
  metricConfigs: [] as ExporterConfig[],
  readerIntervals: [] as Array<number | undefined>,
  cloudPackageLoads: [] as string[],
}));

vi.mock('google-auth-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('google-auth-library')>();
  class FakeGoogleAuth {
    async getProjectId(): Promise<string> {
      return 'my-project';
    }

    async getRequestHeaders(): Promise<Headers> {
      if (state.failCredentials) {
        throw new Error(CREDENTIAL_ERROR_TEXT);
      }
      return new Headers({authorization: 'Bearer token-1'});
    }
  }
  return {...original, GoogleAuth: FakeGoogleAuth};
});

vi.mock('@opentelemetry/exporter-trace-otlp-http', async () => {
  const {InMemorySpanExporter} = await import('@opentelemetry/sdk-trace-base');
  class FakeOtlpTraceExporter extends InMemorySpanExporter {
    constructor(config: ExporterConfig) {
      super();
      state.traceConfigs.push(config);
    }
  }
  return {OTLPTraceExporter: FakeOtlpTraceExporter};
});

vi.mock('@opentelemetry/exporter-metrics-otlp-http', async () => {
  const {AggregationTemporality, InMemoryMetricExporter} =
    await import('@opentelemetry/sdk-metrics');
  class FakeOtlpMetricExporter extends InMemoryMetricExporter {
    constructor(config: ExporterConfig) {
      super(AggregationTemporality.CUMULATIVE);
      state.metricConfigs.push(config);
    }
  }
  return {OTLPMetricExporter: FakeOtlpMetricExporter};
});

vi.mock('@opentelemetry/sdk-metrics', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@opentelemetry/sdk-metrics')>();
  class RecordingMetricReader extends original.PeriodicExportingMetricReader {
    constructor(
      options: ConstructorParameters<
        typeof original.PeriodicExportingMetricReader
      >[0],
    ) {
      super(options);
      state.readerIntervals.push(options.exportIntervalMillis);
    }
  }
  return {...original, PeriodicExportingMetricReader: RecordingMetricReader};
});

vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter', () => {
  state.cloudPackageLoads.push(
    '@google-cloud/opentelemetry-cloud-trace-exporter',
  );
  return {};
});

vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter', () => {
  state.cloudPackageLoads.push(
    '@google-cloud/opentelemetry-cloud-monitoring-exporter',
  );
  return {};
});

describe('getGcpExporters trace and metric export', () => {
  beforeEach(() => {
    state.failCredentials = false;
    state.traceConfigs.length = 0;
    state.metricConfigs.length = 0;
    state.readerIntervals.length = 0;
    for (const name of [
      'GOOGLE_CLOUD_AGENT_ENGINE_ID',
      'GOOGLE_API_USE_CLIENT_CERTIFICATE',
      'GOOGLE_API_USE_MTLS_ENDPOINT',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exports traces over OTLP/HTTP to telemetry.googleapis.com', async () => {
    const hooks = await getGcpExporters({enableTracing: true});

    expect(hooks.spanProcessors).toHaveLength(1);
    expect(state.traceConfigs.map((config) => config.url)).toEqual([
      'https://telemetry.googleapis.com/v1/traces',
    ]);
    expect(await state.traceConfigs[0].headers?.()).toEqual({
      authorization: 'Bearer token-1',
    });
  });

  it('exports metrics over OTLP/HTTP to telemetry.googleapis.com every 5000 ms', async () => {
    const hooks = await getGcpExporters({enableMetrics: true});

    expect(hooks.metricReaders).toHaveLength(1);
    expect(state.metricConfigs.map((config) => config.url)).toEqual([
      'https://telemetry.googleapis.com/v1/metrics',
    ]);
    expect(await state.metricConfigs[0].headers?.()).toEqual({
      authorization: 'Bearer token-1',
    });
    expect(state.readerIntervals).toEqual([5000]);
  });

  it('uses the mTLS endpoints when the client certificate and mTLS are on', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

    await getGcpExporters({enableTracing: true, enableMetrics: true});

    expect(state.traceConfigs.map((config) => config.url)).toEqual([
      'https://telemetry.mtls.googleapis.com/v1/traces',
    ]);
    expect(state.metricConfigs.map((config) => config.url)).toEqual([
      'https://telemetry.mtls.googleapis.com/v1/metrics',
    ]);
  });

  it('exports without authorization, warns once per exporter, and never logs the error text when credentials fail', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    state.failCredentials = true;

    await getGcpExporters({enableTracing: true, enableMetrics: true});

    expect(await state.traceConfigs[0].headers?.()).toEqual({});
    expect(await state.traceConfigs[0].headers?.()).toEqual({});
    expect(await state.metricConfigs[0].headers?.()).toEqual({});
    expect(await state.metricConfigs[0].headers?.()).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    for (const args of warn.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('secret-token-1');
    }
  });

  it('never loads the Cloud Trace or Cloud Monitoring exporter packages', async () => {
    await getGcpExporters({enableTracing: true, enableMetrics: true});

    expect(state.cloudPackageLoads).toEqual([]);
  });

  it('adds no trace or metric export when the signals are off', async () => {
    const hooks = await getGcpExporters({});

    expect(hooks.spanProcessors).toEqual([]);
    expect(hooks.metricReaders).toEqual([]);
    expect(state.traceConfigs).toEqual([]);
    expect(state.metricConfigs).toEqual([]);
  });
});
