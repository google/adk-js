/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  getGcpExporters,
  getGcpProjectId,
} from '../../src/telemetry/google_cloud.js';

interface ExporterConfig {
  url?: string;
  headers?: () => Promise<Record<string, string>>;
}

const state = vi.hoisted(() => ({
  projectId: 'my-project' as string | null,
  getProjectIdCalls: 0,
  exporterConfigs: [] as ExporterConfig[],
  exporters: [] as InMemoryLogRecordExporter[],
  lookups: [] as string[],
}));

vi.mock('google-auth-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('google-auth-library')>();
  class FakeGoogleAuth {
    async getProjectId(): Promise<string | null> {
      state.getProjectIdCalls++;
      return state.projectId;
    }

    async getRequestHeaders(): Promise<Headers> {
      return new Headers({authorization: 'Bearer token-1'});
    }

    async request(opts: {url: string}): Promise<{data: unknown}> {
      state.lookups.push(opts.url);
      if (opts.url.endsWith('/projects/123456789')) {
        return {data: {projectId: 'my-project', name: 'projects/123456789'}};
      }
      if (opts.url.endsWith('/projects/987654321')) {
        return {
          data: {projectId: 'engine-project', name: 'projects/987654321'},
        };
      }
      throw new Error('Unexpected lookup.');
    }
  }
  return {...original, GoogleAuth: FakeGoogleAuth};
});

vi.mock('@opentelemetry/exporter-logs-otlp-http', async () => {
  const {InMemoryLogRecordExporter: Base} =
    await import('@opentelemetry/sdk-logs');
  class FakeOtlpLogExporter extends Base {
    constructor(config: ExporterConfig) {
      super();
      state.exporterConfigs.push(config);
      state.exporters.push(this);
    }
  }
  return {OTLPLogExporter: FakeOtlpLogExporter};
});

describe('getGcpExporters with enableLogging', () => {
  beforeEach(() => {
    state.projectId = 'my-project';
    state.getProjectIdCalls = 0;
    state.exporterConfigs.length = 0;
    state.exporters.length = 0;
    state.lookups.length = 0;
    for (const name of [
      'GOOGLE_CLOUD_AGENT_ENGINE_ID',
      'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
      'GOOGLE_CLOUD_LOCATION',
      'GOOGLE_API_USE_CLIENT_CERTIFICATE',
      'GOOGLE_API_USE_MTLS_ENDPOINT',
      'GCP_DEFAULT_LOG_NAME',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns one log processor exporting to /v1/logs with an auth header', async () => {
    const hooks = await getGcpExporters({enableLogging: true});

    expect(hooks.logRecordProcessors).toHaveLength(1);
    expect(state.exporterConfigs).toHaveLength(1);
    const [config] = state.exporterConfigs;
    expect(config.url).toBe('https://telemetry.googleapis.com/v1/logs');
    expect(await config.headers?.()).toEqual({
      authorization: 'Bearer token-1',
    });
  });

  it('returns no log processor when enableLogging is off', async () => {
    const hooks = await getGcpExporters({enableLogging: false});

    expect(hooks.logRecordProcessors).toEqual([]);
    expect(state.exporterConfigs).toHaveLength(0);
  });

  it('returns no hooks when no project resolves', async () => {
    state.projectId = null;

    const hooks = await getGcpExporters({enableLogging: true});

    expect(hooks).toEqual({});
  });

  it('turns the project number into the project ID on Agent Engine', async () => {
    state.projectId = '123456789';
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'engine-1');
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', 'us-central1');

    const hooks = await getGcpExporters({enableLogging: true});
    const processors = hooks.logRecordProcessors ?? [];
    const provider = new LoggerProvider({processors});
    provider.getLogger('test').emit({eventName: 'test-event'});
    await provider.forceFlush();

    expect(state.lookups).toEqual([
      'https://cloudresourcemanager.googleapis.com/v3/projects/123456789',
    ]);
    const records = state.exporters[0].getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].resource.attributes['resource_container']).toBe(
      'projects/my-project',
    );
    await provider.shutdown();
  });

  it('resolves the project ID in getGcpProjectId on Agent Engine and reuses a passed projectId in getGcpExporters', async () => {
    state.projectId = '987654321';
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'engine-1');
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', 'us-central1');

    const projectId = await getGcpProjectId();
    const hooks = await getGcpExporters({
      enableLogging: true,
      projectId: projectId ?? undefined,
    });

    expect(projectId).toBe('engine-project');
    expect(state.getProjectIdCalls).toBe(1);
    expect(state.lookups).toEqual([
      'https://cloudresourcemanager.googleapis.com/v3/projects/987654321',
    ]);
    const processors = hooks.logRecordProcessors ?? [];
    const provider = new LoggerProvider({processors});
    provider.getLogger('test').emit({eventName: 'test-event'});
    await provider.forceFlush();
    const records = state.exporters[0].getFinishedLogRecords();
    expect(records[0].resource.attributes['resource_container']).toBe(
      'projects/engine-project',
    );
    await provider.shutdown();
  });
});
