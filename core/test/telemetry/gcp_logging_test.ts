/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import type {AddressInfo} from 'node:net';

import {resourceFromAttributes} from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordProcessor,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  createGcpLogRecordProcessor,
  DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
  DEFAULT_TELEMETRY_LOGS_ENDPOINT,
  selectTelemetryEndpoint,
} from '../../src/telemetry/gcp_logging.js';
import {logger} from '../../src/utils/logger.js';

const CLOUD_ENV_VARS = [
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_USE_MTLS_ENDPOINT',
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY',
  'GOOGLE_CLOUD_LOCATION',
  'GCP_DEFAULT_LOG_NAME',
];

const COMPLETION_DETAILS = 'gen_ai.client.inference.operation.details';

/** Fake credentials that hand out a new token on every call. */
class FakeAuth {
  calls = 0;

  async getRequestHeaders(): Promise<Headers> {
    this.calls++;
    return new Headers({authorization: `Bearer token-${this.calls}`});
  }
}

interface Pipeline {
  provider: LoggerProvider;
  gcpRecords: () => ReadableLogRecord[];
  otherRecords: () => ReadableLogRecord[];
}

function createPipeline(): Pipeline {
  const gcpExporter = new InMemoryLogRecordExporter();
  const otherExporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'my-agent',
      'service.version': '1.2.3',
    }),
    processors: [
      createGcpLogRecordProcessor({
        projectId: 'my-project',
        auth: new FakeAuth(),
        exporter: gcpExporter,
      }),
      new SimpleLogRecordProcessor({exporter: otherExporter}),
    ],
  });
  return {
    provider,
    gcpRecords: () => gcpExporter.getFinishedLogRecords(),
    otherRecords: () => otherExporter.getFinishedLogRecords(),
  };
}

async function emitOne(
  pipeline: Pipeline,
  attributes: Record<string, string> = {},
): Promise<{gcp: ReadableLogRecord; other: ReadableLogRecord}> {
  pipeline.provider.getLogger('test').emit({
    eventName: COMPLETION_DETAILS,
    body: 'hello',
    attributes: {'gen_ai.operation.name': 'generate_content', ...attributes},
  });
  await pipeline.provider.forceFlush();
  expect(pipeline.gcpRecords()).toHaveLength(1);
  expect(pipeline.otherRecords()).toHaveLength(1);
  return {gcp: pipeline.gcpRecords()[0], other: pipeline.otherRecords()[0]};
}

describe('gcp_logging', () => {
  beforeEach(() => {
    for (const name of CLOUD_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('selectTelemetryEndpoint', () => {
    const endpoints = {
      defaultEndpoint: DEFAULT_TELEMETRY_LOGS_ENDPOINT,
      mtlsEndpoint: DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
    };

    it.each([
      {mode: undefined, certSource: false, expected: 'plain'},
      {mode: 'auto', certSource: false, expected: 'plain'},
      {mode: 'auto', certSource: true, expected: 'mtls'},
      {mode: 'always', certSource: false, expected: 'mtls'},
      {mode: 'ALWAYS', certSource: false, expected: 'mtls'},
      {mode: 'never', certSource: true, expected: 'plain'},
    ])(
      'uses the $expected endpoint for GOOGLE_API_USE_MTLS_ENDPOINT=$mode with a cert source $certSource',
      ({mode, certSource, expected}) => {
        vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
        vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', mode);

        expect(
          selectTelemetryEndpoint({
            ...endpoints,
            hasClientCertSource: certSource,
          }),
        ).toBe(
          expected === 'mtls'
            ? DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT
            : DEFAULT_TELEMETRY_LOGS_ENDPOINT,
        );
      },
    );

    it('warns on an invalid GOOGLE_API_USE_MTLS_ENDPOINT and acts as auto', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');

      expect(
        selectTelemetryEndpoint({...endpoints, hasClientCertSource: true}),
      ).toBe(DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT);
      expect(
        selectTelemetryEndpoint({...endpoints, hasClientCertSource: false}),
      ).toBe(DEFAULT_TELEMETRY_LOGS_ENDPOINT);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('GOOGLE_API_USE_MTLS_ENDPOINT'),
      );
    });

    it('always uses the plain endpoint with client certificates off', () => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

      expect(
        selectTelemetryEndpoint({...endpoints, hasClientCertSource: true}),
      ).toBe(DEFAULT_TELEMETRY_LOGS_ENDPOINT);
    });

    it('warns on an invalid GOOGLE_API_USE_CLIENT_CERTIFICATE and treats it as false', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'yes');
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

      expect(selectTelemetryEndpoint(endpoints)).toBe(
        DEFAULT_TELEMETRY_LOGS_ENDPOINT,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('GOOGLE_API_USE_CLIENT_CERTIFICATE'),
      );
    });
  });

  describe('Cloud Logging rewrites off Agent Engine', () => {
    it('sets event.name, gcp.log_name and service.version on its own copy', async () => {
      const pipeline = createPipeline();

      const {gcp, other} = await emitOne(pipeline);

      expect(gcp.attributes).toEqual({
        'gen_ai.operation.name': 'generate_content',
        'event.name': COMPLETION_DETAILS,
        'gcp.log_name': 'adk-otel',
        'service.version': '1.2.3',
      });
      expect(gcp.eventName).toBe(COMPLETION_DETAILS);
      expect(gcp.body).toBe('hello');
      expect(gcp.resource.attributes).toEqual({
        'service.name': 'my-agent',
        'service.version': '1.2.3',
      });
      expect(other.attributes).toEqual({
        'gen_ai.operation.name': 'generate_content',
      });
      expect(other.eventName).toBe(COMPLETION_DETAILS);
      expect(other.resource.attributes).toEqual({
        'service.name': 'my-agent',
        'service.version': '1.2.3',
      });
      await pipeline.provider.shutdown();
    });

    it('keeps attributes the record already sets', async () => {
      const pipeline = createPipeline();

      const {gcp} = await emitOne(pipeline, {
        'event.name': 'custom-event',
        'gcp.log_name': 'custom-log',
        'service.version': '9.9.9',
      });

      expect(gcp.attributes['event.name']).toBe('custom-event');
      expect(gcp.attributes['gcp.log_name']).toBe('custom-log');
      expect(gcp.attributes['service.version']).toBe('9.9.9');
      await pipeline.provider.shutdown();
    });

    it('uses GCP_DEFAULT_LOG_NAME as the default log name', async () => {
      vi.stubEnv('GCP_DEFAULT_LOG_NAME', 'my-log');
      const pipeline = createPipeline();

      const {gcp} = await emitOne(pipeline);

      expect(gcp.attributes['gcp.log_name']).toBe('my-log');
      await pipeline.provider.shutdown();
    });

    it('ignores an empty GCP_DEFAULT_LOG_NAME and keeps adk-otel', async () => {
      vi.stubEnv('GCP_DEFAULT_LOG_NAME', '');
      const pipeline = createPipeline();

      const {gcp} = await emitOne(pipeline);

      expect(gcp.attributes['gcp.log_name']).toBe('adk-otel');
      await pipeline.provider.shutdown();
    });

    it('maps every record of one resource to one merged resource', async () => {
      const pipeline = createPipeline();
      const otelLogger = pipeline.provider.getLogger('test');

      otelLogger.emit({eventName: COMPLETION_DETAILS});
      otelLogger.emit({eventName: COMPLETION_DETAILS});
      await pipeline.provider.forceFlush();

      const [first, second] = pipeline.gcpRecords();
      expect(first.resource).toBe(second.resource);
      await pipeline.provider.shutdown();
    });
  });

  describe('Cloud Logging rewrites on Agent Engine', () => {
    beforeEach(() => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'engine-1');
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', 'us-central1');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west1');
    });

    it('clears eventName and merges the Agent Engine resource on its copy only', async () => {
      const pipeline = createPipeline();

      const {gcp, other} = await emitOne(pipeline);

      expect(gcp.eventName).toBeUndefined();
      expect(gcp.attributes['event.name']).toBe(COMPLETION_DETAILS);
      expect(gcp.attributes['gcp.log_name']).toBe(
        'aiplatform.googleapis.com/reasoning_engine_stdout',
      );
      expect(gcp.resource.attributes).toEqual({
        'service.name': 'my-agent',
        'service.version': '1.2.3',
        'gcp.resource_type': 'aiplatform.googleapis.com/ReasoningEngine',
        'location': 'us-central1',
        'reasoning_engine_id': 'engine-1',
        'resource_container': 'projects/my-project',
      });
      expect(other.eventName).toBe(COMPLETION_DETAILS);
      expect(other.attributes).toEqual({
        'gen_ai.operation.name': 'generate_content',
      });
      expect(other.resource.attributes).not.toHaveProperty('gcp.resource_type');
      await pipeline.provider.shutdown();
    });

    it('falls back to GOOGLE_CLOUD_LOCATION for the location', async () => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION', undefined);
      const pipeline = createPipeline();

      const {gcp} = await emitOne(pipeline);

      expect(gcp.resource.attributes['location']).toBe('europe-west1');
      await pipeline.provider.shutdown();
    });

    it('still lets GCP_DEFAULT_LOG_NAME override the log name', async () => {
      vi.stubEnv('GCP_DEFAULT_LOG_NAME', 'my-log');
      const pipeline = createPipeline();

      const {gcp} = await emitOne(pipeline);

      expect(gcp.attributes['gcp.log_name']).toBe('my-log');
      await pipeline.provider.shutdown();
    });
  });

  describe('export to telemetry.googleapis.com', () => {
    interface CapturedRequest {
      url?: string;
      headers: http.IncomingHttpHeaders;
      body: string;
    }

    let server: http.Server;
    let requests: CapturedRequest[];
    let endpoint: string;

    beforeEach(async () => {
      requests = [];
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          requests.push({
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
          res.writeHead(200, {'content-type': 'application/json'});
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const {port} = server.address() as AddressInfo;
      endpoint = `http://127.0.0.1:${port}/v1/logs`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    function createExportingProvider(auth: {
      getRequestHeaders(): Promise<Headers>;
    }): {provider: LoggerProvider; processor: LogRecordProcessor} {
      const processor = createGcpLogRecordProcessor({
        projectId: 'my-project',
        auth,
        endpoint,
      });
      return {
        provider: new LoggerProvider({
          resource: resourceFromAttributes({'service.name': 'my-agent'}),
          processors: [processor],
        }),
        processor,
      };
    }

    it('posts each batch to /v1/logs with a fresh authorization header', async () => {
      const auth = new FakeAuth();
      const {provider} = createExportingProvider(auth);
      const otelLogger = provider.getLogger('test');

      otelLogger.emit({eventName: COMPLETION_DETAILS, body: 'first'});
      await provider.forceFlush();
      otelLogger.emit({eventName: COMPLETION_DETAILS, body: 'second'});
      await provider.forceFlush();
      await provider.shutdown();

      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.url)).toEqual([
        '/v1/logs',
        '/v1/logs',
      ]);
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        'Bearer token-1',
        'Bearer token-2',
      ]);
      expect(requests[0].headers['user-agent']).toMatch(
        /^OTel-OTLP-Exporter-JavaScript\//,
      );
      const body = JSON.parse(requests[0].body);
      const [record] = body.resourceLogs[0].scopeLogs[0].logRecords;
      expect(record.body).toEqual({stringValue: 'first'});
      expect(record.eventName).toBe(COMPLETION_DETAILS);
      expect(record.attributes).toEqual(
        expect.arrayContaining([
          {key: 'event.name', value: {stringValue: COMPLETION_DETAILS}},
          {key: 'gcp.log_name', value: {stringValue: 'adk-otel'}},
        ]),
      );
    });

    it('still exports, without credentials, and warns once when credentials fail repeatedly', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const {provider} = createExportingProvider({
        getRequestHeaders: () => Promise.reject(new Error('secret-detail')),
      });

      provider.getLogger('test').emit({eventName: COMPLETION_DETAILS});
      await provider.forceFlush();
      provider.getLogger('test').emit({eventName: COMPLETION_DETAILS});
      await provider.forceFlush();
      await provider.shutdown();

      expect(requests).toHaveLength(2);
      expect(requests[0].headers.authorization).toBeUndefined();
      expect(requests[1].headers.authorization).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('secret-detail');
    });

    it('sends the same User-Agent with GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY set', async () => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY', 'true');
      const {provider} = createExportingProvider(new FakeAuth());

      provider.getLogger('test').emit({eventName: COMPLETION_DETAILS});
      await provider.forceFlush();
      await provider.shutdown();

      expect(requests[0].headers['user-agent']).toMatch(
        /^OTel-OTLP-Exporter-JavaScript\/[\d.]+$/,
      );
    });
  });
});
