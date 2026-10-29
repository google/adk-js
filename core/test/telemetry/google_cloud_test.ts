/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GCPBatchLogRecordProcessor,
  getGcpExporters,
  getGcpProjectId,
  getGcpResource,
  OtelExportersConfig,
} from '@google/adk';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {
  emptyResource,
  Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {ReadWriteLogRecord} from '@opentelemetry/sdk-logs';
import {ResourceMetrics} from '@opentelemetry/sdk-metrics';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';
import * as fs from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AuthenticatedLogExporter,
  AuthenticatedMetricExporter,
  AuthenticatedTraceExporter,
  clearProjectCache,
  fetchProject,
  getAgentEngineUserAgentHeader,
  getTelemetryEndpoint,
} from '../../src/telemetry/export/google_cloud.js';
import {logger} from '../../src/utils/logger.js';
import {version} from '../../src/version.js';

vi.mock('../../src/utils/logger.js');
vi.mock('@opentelemetry/resource-detector-gcp', () => ({
  gcpDetector: {
    detect: vi.fn().mockReturnValue({attributes: {}}),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(actual.readFileSync),
    },
    readFileSync: vi.fn(actual.readFileSync),
  };
});

function makeAuthResponse<T>(
  data: T,
): Awaited<ReturnType<GoogleAuth['request']>> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  } as unknown as Awaited<ReturnType<GoogleAuth['request']>>;
}

describe('getGcpExporters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearProjectCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearProjectCache();
  });

  const testCases: Array<{
    config: OtelExportersConfig;
    expectedSpanProcessors: number;
    expectedMetricReaders: number;
    expectedLogRecordProcessors: number;
    description: string;
  }> = [
    {
      config: {
        enableTracing: true,
        enableMetrics: false,
        enableLogging: false,
      },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Trace when enableTracing is true',
    },
    {
      config: {
        enableTracing: false,
        enableMetrics: true,
        enableLogging: false,
      },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Monitoring when enableMetrics is true',
    },
    {
      config: {
        enableTracing: false,
        enableMetrics: false,
        enableLogging: true,
      },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 1,
      description: 'should set up Cloud Logging when enableLogging is true',
    },
    {
      config: {
        enableTracing: true,
        enableMetrics: true,
        enableLogging: true,
      },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 1,
      description: 'should set up all exporters when all options are enabled',
    },
    {
      config: {
        enableTracing: false,
        enableMetrics: false,
        enableLogging: false,
      },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0,
      description: 'should set up no exporters when all options are false',
    },
  ];

  testCases.forEach(
    ({
      config,
      expectedSpanProcessors,
      expectedMetricReaders,
      expectedLogRecordProcessors,
      description,
    }) => {
      it(description, async () => {
        const mockAuth = {
          getProjectId: vi.fn().mockResolvedValue('test-project'),
          getRequestHeaders: vi
            .fn()
            .mockResolvedValue({Authorization: 'Bearer token'}),
          request: vi.fn(),
        } as unknown as GoogleAuth;

        const result = await getGcpExporters({
          ...config,
          auth: mockAuth,
        });

        expect(result.spanProcessors?.length).toBe(expectedSpanProcessors);
        expect(result.metricReaders?.length).toBe(expectedMetricReaders);
        expect(result.logRecordProcessors?.length).toBe(
          expectedLogRecordProcessors,
        );
      });
    },
  );

  it('should return empty hooks when GoogleAuth fails to get project ID', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockRejectedValue(new Error('Auth error')),
    } as unknown as GoogleAuth;

    const result = await getGcpExporters({
      enableTracing: true,
      auth: mockAuth,
    });

    expect(result).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cannot determine GCP Project'),
    );
  });

  it('should return empty hooks when project ID is undefined', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockResolvedValue(undefined),
    } as unknown as GoogleAuth;

    const result = await getGcpExporters({
      enableTracing: true,
      auth: mockAuth,
    });

    expect(result).toEqual({});
  });

  it('resolves project number to ID on Agent Engine', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'agent-123');
    const mockAuth = {
      getProjectId: vi.fn().mockResolvedValue('123456789'),
      getRequestHeaders: vi
        .fn()
        .mockResolvedValue({Authorization: 'Bearer token'}),
      request: vi.fn().mockResolvedValue(
        makeAuthResponse({
          name: 'projects/123456789',
          projectId: 'resolved-project-id',
        }),
      ),
    } as unknown as GoogleAuth;

    const result = await getGcpExporters({
      enableLogging: true,
      auth: mockAuth,
    });

    expect(result.logRecordProcessors?.length).toBe(1);
  });
});

describe('getGcpProjectId', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns GOOGLE_CLOUD_PROJECT when set', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    const result = await getGcpProjectId();
    expect(result).toBe('env-project');
  });

  it('falls back to auth.getProjectId when env var is unset', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockResolvedValue('adc-project'),
    } as unknown as GoogleAuth;

    const result = await getGcpProjectId(mockAuth);
    expect(result).toBe('adc-project');
  });

  it('returns undefined when auth fails', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockRejectedValue(new Error('Auth failed')),
    } as unknown as GoogleAuth;

    const result = await getGcpProjectId(mockAuth);
    expect(result).toBeUndefined();
  });
});

describe('endpoint selection and User-Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const defaultEndpoint = 'https://telemetry.googleapis.com/v1/traces';
  const mtlsEndpoint = 'https://telemetry.mtls.googleapis.com/v1/traces';

  it('returns default endpoint when neither mTLS nor client cert is configured', () => {
    expect(getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint)).toBe(
      defaultEndpoint,
    );
  });

  it('returns mtls endpoint when GOOGLE_API_USE_CLIENT_CERTIFICATE is true', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    expect(getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint)).toBe(
      mtlsEndpoint,
    );
  });

  it('returns mtls endpoint when GOOGLE_API_USE_MTLS_ENDPOINT is always', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    expect(getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint)).toBe(
      mtlsEndpoint,
    );
  });

  it('returns default endpoint when GOOGLE_API_USE_MTLS_ENDPOINT is never even if cert is true', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    expect(getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint)).toBe(
      defaultEndpoint,
    );
  });

  it('warns when GOOGLE_API_USE_CLIENT_CERTIFICATE is invalid', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'invalid-value');
    getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'GOOGLE_API_USE_CLIENT_CERTIFICATE` must be either `true` or `false`',
      ),
    );
  });

  it('warns when GOOGLE_API_USE_MTLS_ENDPOINT is invalid', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'invalid');
    getTelemetryEndpoint(defaultEndpoint, mtlsEndpoint);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GOOGLE_API_USE_MTLS_ENDPOINT` must be one of'),
    );
  });

  it('includes Vertex-Agent-Engine User-Agent when telemetry env is enabled', () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY', '1');
    const headers = getAgentEngineUserAgentHeader();
    expect(headers['User-Agent']).toBe(`Vertex-Agent-Engine/${version}`);
  });

  it('omits User-Agent when telemetry env is not set', () => {
    const headers = getAgentEngineUserAgentHeader();
    expect(headers['User-Agent']).toBeUndefined();
  });
});

describe('authenticated exporters and error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AuthenticatedTraceExporter warns once on auth failure across multiple exports', async () => {
    const mockAuth = {
      getRequestHeaders: vi
        .fn()
        .mockRejectedValue(new Error('ADC lookup failed')),
    } as unknown as GoogleAuth;

    const exporter = new AuthenticatedTraceExporter(
      mockAuth,
      'https://telemetry.googleapis.com/v1/traces',
    );

    const firstResult = await new Promise<{code: number; error?: Error}>(
      (resolve) => {
        exporter.export([] as ReadableSpan[], resolve);
      },
    );
    expect(firstResult.code).toBe(1);
    expect(firstResult.error?.message).toBe('ADC lookup failed');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const secondResult = await new Promise<{code: number; error?: Error}>(
      (resolve) => {
        exporter.export([] as ReadableSpan[], resolve);
      },
    );
    expect(secondResult.code).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('AuthenticatedMetricExporter warns once on auth failure', async () => {
    const mockAuth = {
      getRequestHeaders: vi
        .fn()
        .mockRejectedValue(new Error('Credentials expired')),
    } as unknown as GoogleAuth;

    const exporter = new AuthenticatedMetricExporter(
      mockAuth,
      'https://telemetry.googleapis.com/v1/metrics',
    );

    const mockMetrics: ResourceMetrics = {
      resource: emptyResource(),
      scopeMetrics: [],
    };
    const callback = vi.fn();
    exporter.export(mockMetrics, callback);
    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({code: 1, error: expect.any(Error)}),
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('AuthenticatedLogExporter warns once on auth failure', async () => {
    const mockAuth = {
      getRequestHeaders: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as GoogleAuth;

    const exporter = new AuthenticatedLogExporter(
      mockAuth,
      'https://telemetry.googleapis.com/v1/logs',
    );

    const callback = vi.fn();
    exporter.export([], callback);
    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({code: 1, error: expect.any(Error)}),
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('GCPBatchLogRecordProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeMockRecord(options: {
    attributes?: Record<string, unknown>;
    eventName?: string;
    resource?: Resource;
  }): ReadWriteLogRecord {
    const attrs = {...(options.attributes ?? {})};
    return {
      attributes: attrs,
      eventName: options.eventName,
      resource: options.resource ?? emptyResource(),
      hrTime: [1, 0],
      hrTimeObserved: [1, 0],
      droppedAttributesCount: 0,
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setBody: vi.fn(),
      setSeverityNumber: vi.fn(),
      setSeverityText: vi.fn(),
    } as unknown as ReadWriteLogRecord;
  }

  it('creates a shallow copy and does not mutate the original log record', () => {
    const mockExporter = {
      export: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new GCPBatchLogRecordProcessor(
      mockExporter,
      'test-project',
    );

    const originalRecord = makeMockRecord({
      attributes: {originalKey: 'originalVal'},
      eventName: 'my-event',
    });

    processor.onEmit(originalRecord);

    expect(originalRecord.attributes['event.name']).toBeUndefined();
    expect(originalRecord.attributes['gcp.log_name']).toBeUndefined();
    expect(originalRecord.eventName).toBe('my-event');
  });

  it('sets event.name from eventName and defaults gcp.log_name to adk-otel', async () => {
    let captured: ReadWriteLogRecord | undefined;
    const mockExporter = {
      export: vi.fn(
        (
          batch: ReadWriteLogRecord[],
          callback: (result: {code: number}) => void,
        ) => {
          captured = batch[0];
          callback({code: 0});
        },
      ),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new GCPBatchLogRecordProcessor(
      mockExporter,
      'test-project',
    );

    processor.onEmit(
      makeMockRecord({
        eventName: 'inference_event',
      }),
    );
    await processor.forceFlush();

    expect(captured?.attributes['event.name']).toBe('inference_event');
    expect(captured?.attributes['gcp.log_name']).toBe('adk-otel');
  });

  it('honors non-empty GCP_DEFAULT_LOG_NAME', async () => {
    vi.stubEnv('GCP_DEFAULT_LOG_NAME', 'custom-log-name');
    let captured: ReadWriteLogRecord | undefined;
    const mockExporter = {
      export: vi.fn(
        (
          batch: ReadWriteLogRecord[],
          callback: (result: {code: number}) => void,
        ) => {
          captured = batch[0];
          callback({code: 0});
        },
      ),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new GCPBatchLogRecordProcessor(
      mockExporter,
      'test-project',
    );

    processor.onEmit(makeMockRecord({}));
    await processor.forceFlush();

    expect(captured?.attributes['gcp.log_name']).toBe('custom-log-name');
  });

  it('ignores empty GCP_DEFAULT_LOG_NAME and falls back to adk-otel', async () => {
    vi.stubEnv('GCP_DEFAULT_LOG_NAME', '   ');
    let captured: ReadWriteLogRecord | undefined;
    const mockExporter = {
      export: vi.fn(
        (
          batch: ReadWriteLogRecord[],
          callback: (result: {code: number}) => void,
        ) => {
          captured = batch[0];
          callback({code: 0});
        },
      ),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new GCPBatchLogRecordProcessor(
      mockExporter,
      'test-project',
    );

    processor.onEmit(makeMockRecord({}));
    await processor.forceFlush();

    expect(captured?.attributes['gcp.log_name']).toBe('adk-otel');
  });

  it('on Agent Engine, clears eventName and applies stdout log and resource hints', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'engine-123');
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', 'us-central1');

    let captured: ReadWriteLogRecord | undefined;
    const mockExporter = {
      export: vi.fn(
        (
          batch: ReadWriteLogRecord[],
          callback: (result: {code: number}) => void,
        ) => {
          captured = batch[0];
          callback({code: 0});
        },
      ),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new GCPBatchLogRecordProcessor(
      mockExporter,
      'my-project',
    );

    processor.onEmit(
      makeMockRecord({
        eventName: 'test_event',
        resource: resourceFromAttributes({'service.version': '1.0.0'}),
      }),
    );
    await processor.forceFlush();

    expect(captured?.eventName).toBeUndefined();
    expect(captured?.attributes['event.name']).toBe('test_event');
    expect(captured?.attributes['gcp.log_name']).toBe(
      'aiplatform.googleapis.com/reasoning_engine_stdout',
    );
    expect(captured?.attributes['service.version']).toBe('1.0.0');
    expect(captured?.resource.attributes['gcp.resource_type']).toBe(
      'aiplatform.googleapis.com/ReasoningEngine',
    );
    expect(captured?.resource.attributes['reasoning_engine_id']).toBe(
      'engine-123',
    );
    expect(captured?.resource.attributes['resource_container']).toBe(
      'projects/my-project',
    );
    expect(captured?.resource.attributes['location']).toBe('us-central1');
  });
});

describe('fetchProject and Resource Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProjectCache();
  });

  afterEach(() => {
    clearProjectCache();
  });

  it('fetches project info via Cloud Resource Manager and caches result', async () => {
    const mockAuth = {
      request: vi.fn().mockResolvedValue(
        makeAuthResponse({
          name: 'projects/987654321',
          projectId: 'my-project-id',
        }),
      ),
    } as unknown as GoogleAuth;

    const first = await fetchProject('my-project-id', mockAuth);
    expect(first).toEqual({
      id: 'my-project-id',
      number: '987654321',
    });
    expect(mockAuth.request).toHaveBeenCalledTimes(1);

    const second = await fetchProject('my-project-id', mockAuth);
    expect(second).toEqual({
      id: 'my-project-id',
      number: '987654321',
    });
    expect(mockAuth.request).toHaveBeenCalledTimes(1);
  });

  it('does not treat all-digit project input as project number when lookup fails', async () => {
    const mockAuth = {
      request: vi.fn().mockRejectedValue(new Error('PermissionDenied')),
    } as unknown as GoogleAuth;

    const failed = await fetchProject('123456789', mockAuth);
    expect(failed).toEqual({
      id: '',
      number: '',
    });
  });

  it('evicts the oldest cached project when exceeding 32 entries', async () => {
    const mockAuth = {
      request: vi.fn((opts: {url: string}) => {
        const match = opts.url.match(/projects\/(.+)$/);
        const id = match ? decodeURIComponent(match[1]) : 'unknown';
        return Promise.resolve(
          makeAuthResponse({
            name: `projects/${id}-num`,
            projectId: id,
          }),
        );
      }),
    } as unknown as GoogleAuth;

    for (let i = 0; i < 33; i++) {
      await fetchProject(`proj-${i}`, mockAuth);
    }
    expect(mockAuth.request).toHaveBeenCalledTimes(33);

    // proj-32 is still cached
    await fetchProject('proj-32', mockAuth);
    expect(mockAuth.request).toHaveBeenCalledTimes(33);

    // proj-0 was evicted and triggers a new lookup
    await fetchProject('proj-0', mockAuth);
    expect(mockAuth.request).toHaveBeenCalledTimes(34);
  });

  it('warns describing resourcemanager.projects.get on failure and does not cache failure', async () => {
    const mockAuth = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error('PermissionDenied'))
        .mockResolvedValueOnce(
          makeAuthResponse({
            name: 'projects/111222',
            projectId: 'retry-project',
          }),
        ),
    } as unknown as GoogleAuth;

    const failed = await fetchProject('retry-project', mockAuth);
    expect(failed.number).toBe('');
    expect(failed.id).toBe('retry-project');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('resourcemanager.projects.get'),
      expect.any(Object),
    );

    const success = await fetchProject('retry-project', mockAuth);
    expect(success).toEqual({
      id: 'retry-project',
      number: '111222',
    });
    expect(mockAuth.request).toHaveBeenCalledTimes(2);
  });
});

describe('getGcpResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearProjectCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearProjectCache();
  });

  it('generates distinct service.instance.id for each call', async () => {
    const res1 = await getGcpResource('my-project');
    const res2 = await getGcpResource('my-project');

    expect(res1.attributes['service.instance.id']).toBeDefined();
    expect(res2.attributes['service.instance.id']).toBeDefined();
    expect(res1.attributes['service.instance.id']).not.toBe(
      res2.attributes['service.instance.id'],
    );
  });

  it('falls back to GOOGLE_CLOUD_PROJECT when no projectId argument is given', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    const res = await getGcpResource();

    expect(res.attributes['gcp.project_id']).toBe('env-project');
    expect(res.attributes['cloud.account.id']).toBe('env-project');
  });

  it('falls back to ADC when neither argument nor env var is provided', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getProjectId').mockImplementation(
      async () => 'adc-project',
    );
    const res = await getGcpResource();

    expect(res.attributes['gcp.project_id']).toBe('adc-project');
    expect(res.attributes['cloud.account.id']).toBe('adc-project');
  });

  it('reconstructs Agent Engine URN from GOOGLE_CLOUD_AGENT_ENGINE_ID even when service.name is overridden', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'reasoning-engine-999');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    vi.stubEnv('OTEL_SERVICE_NAME', 'overridden-service-name');

    vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      makeAuthResponse({
        name: 'projects/123456789',
        projectId: 'my-project',
      }),
    );

    const res = await getGcpResource('my-project');

    expect(res.attributes['cloud.platform']).toBe('gcp.agent_engine');
    expect(res.attributes['service.name']).toBe('overridden-service-name');
    expect(res.attributes['gen_ai.main_agent.id']).toBe(
      'urn:agent:projects-123456789:projects:123456789:locations:us-central1:aiplatform:reasoningEngines:reasoning-engine-999',
    );
  });

  it('reconstructs GKE URN with regional cluster', async () => {
    vi.mocked(gcpDetector.detect).mockReturnValue(
      resourceFromAttributes({
        'cloud.platform': 'gcp_kubernetes_engine',
        'cloud.account.id': 'my-project',
        'cloud.region': 'us-central1',
        'k8s.cluster.name': 'my-cluster',
        'k8s.namespace.name': 'default',
        'k8s.deployment.name': 'my-agent',
      }),
    );

    vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      makeAuthResponse({
        name: 'projects/123456789',
        projectId: 'my-project',
      }),
    );

    const res = await getGcpResource('my-project');

    expect(res.attributes['gen_ai.main_agent.id']).toBe(
      'urn:agent:projects-123456789:projects:123456789:locations:us-central1:container:clusters:my-cluster:k8s:namespaces:default:apps:deployments:my-agent',
    );
  });

  it('reconstructs GKE URN with zonal cluster and pod attributes fallback', async () => {
    vi.mocked(gcpDetector.detect).mockReturnValue(
      resourceFromAttributes({
        'cloud.platform': 'gcp_kubernetes_engine',
        'cloud.account.id': 'my-project',
        'cloud.availability_zone': 'us-central1-c',
        'k8s.cluster.name': 'my-cluster',
      }),
    );

    vi.stubEnv('HOSTNAME', 'agent-deployment-7d8f9c5b4-xk2p9');
    vi.mocked(fs.readFileSync).mockReturnValue('custom-namespace\n');

    vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      makeAuthResponse({
        name: 'projects/123456789',
        projectId: 'my-project',
      }),
    );

    const res = await getGcpResource('my-project');

    expect(res.attributes['gen_ai.main_agent.id']).toBe(
      'urn:agent:projects-123456789:projects:123456789:zones:us-central1-c:container:clusters:my-cluster:k8s:namespaces:custom-namespace:apps:deployments:agent-deployment',
    );
  });

  it('reconstructs Cloud Run URN from faas.name', async () => {
    vi.mocked(gcpDetector.detect).mockReturnValue(
      resourceFromAttributes({
        'cloud.platform': 'gcp_cloud_run',
        'cloud.account.id': 'my-project',
        'cloud.region': 'us-central1',
        'faas.name': 'cloud-run-agent',
      }),
    );

    vi.spyOn(GoogleAuth.prototype, 'request').mockResolvedValue(
      makeAuthResponse({
        name: 'projects/123456789',
        projectId: 'my-project',
      }),
    );

    const res = await getGcpResource('my-project');

    expect(res.attributes['gen_ai.main_agent.id']).toBe(
      'urn:agent:projects-123456789:projects:123456789:locations:us-central1:run:services:cloud-run-agent',
    );
  });

  it('omits URN when project number lookup fails', async () => {
    vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'reasoning-engine-999');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    vi.spyOn(GoogleAuth.prototype, 'request').mockRejectedValue(
      new Error('Resource Manager API disabled'),
    );

    const res = await getGcpResource('my-project');

    expect(res.attributes['gen_ai.main_agent.id']).toBeUndefined();
    expect(res.attributes['gcp.project_id']).toBe('my-project');
  });

  it('leaves existing gen_ai.main_agent.id untouched if already present', async () => {
    vi.mocked(gcpDetector.detect).mockReturnValue(
      resourceFromAttributes({
        'gen_ai.main_agent.id': 'urn:agent:already:set',
        'cloud.platform': 'gcp_cloud_run',
      }),
    );

    const res = await getGcpResource('my-project');
    expect(res.attributes['gen_ai.main_agent.id']).toBe(
      'urn:agent:already:set',
    );
  });
});
