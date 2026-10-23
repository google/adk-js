/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {maybeSetOtelProviders} from '@google/adk';
import {logs} from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('maybeSetOtelProviders resource', () => {
  afterEach(() => {
    logs.disable();
    vi.unstubAllEnvs();
  });

  it('puts OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES on exported records', () => {
    for (const name of [
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('OTEL_SERVICE_NAME', 'my-service');
    vi.stubEnv(
      'OTEL_RESOURCE_ATTRIBUTES',
      'deployment.environment=staging,team=agents',
    );
    const exporter = new InMemoryLogRecordExporter();

    maybeSetOtelProviders([
      {logRecordProcessors: [new SimpleLogRecordProcessor({exporter})]},
    ]);
    logs.getLogger('test').emit({body: 'hello'});

    const [record] = exporter.getFinishedLogRecords();
    expect(record.resource.attributes).toEqual({
      'service.name': 'my-service',
      'deployment.environment': 'staging',
      'team': 'agents',
    });
  });
});
