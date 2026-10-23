/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpProjectId,
  getGcpResource,
  maybeSetOtelProviders,
  OTelHooks,
} from '@google/adk';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/adk')>();
  return {
    ...original,
    getGcpExporters: vi.fn(),
    getGcpProjectId: vi.fn(),
    getGcpResource: vi.fn(),
    maybeSetOtelProviders: vi.fn(),
  };
});

describe('setupTelemetry', () => {
  const spanProcessor = new SimpleSpanProcessor(new InMemorySpanExporter());
  const logRecordProcessor = new SimpleLogRecordProcessor({
    exporter: new InMemoryLogRecordExporter(),
  });
  const internalHooks: OTelHooks = {
    spanProcessors: [spanProcessor],
    logRecordProcessors: [logRecordProcessor],
  };

  beforeEach(() => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('enables Cloud Logging and names the project in the resource with otelToCloud', async () => {
    const gcpHooks: OTelHooks = {logRecordProcessors: []};
    const resource = resourceFromAttributes({'gcp.project_id': 'my-project'});
    vi.mocked(getGcpExporters).mockResolvedValue(gcpHooks);
    vi.mocked(getGcpProjectId).mockResolvedValue('my-project');
    vi.mocked(getGcpResource).mockReturnValue(resource);

    await setupTelemetry(true, internalHooks);

    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableLogging: true,
      enableMetrics: true,
      projectId: 'my-project',
    });
    expect(getGcpResource).toHaveBeenCalledWith('my-project');
    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [internalHooks, gcpHooks],
      resource,
    );
  });

  it('forwards the internal log processors on the OTLP environment path', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');

    await setupTelemetry(false, internalHooks);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([internalHooks]);
    expect(getGcpExporters).not.toHaveBeenCalled();
  });

  it('forwards the internal log processors on the default path', async () => {
    await setupTelemetry(false, internalHooks);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([internalHooks]);
  });

  it('still takes a plain array as span processors', async () => {
    await setupTelemetry(false, [spanProcessor]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith([
      {spanProcessors: [spanProcessor]},
    ]);
  });
});
