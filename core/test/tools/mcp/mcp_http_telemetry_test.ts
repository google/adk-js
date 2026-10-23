/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MCPSessionManager} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {logs, SeverityNumber} from '@opentelemetry/api-logs';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {createObservedFetch} from '../../../src/tools/mcp/mcp_http_telemetry.js';
import {logger} from '../../../src/utils/logger.js';

type FetchInit = Parameters<typeof fetch>[1];

const EVENT_NAME = 'adk.experimental.mcp.http.client.response.end';
/**
 * Returns `url` with the given userinfo. The userinfo is set at runtime so the
 * source holds no credential-shaped URL literal.
 */
function withUserinfo(url: string, username: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.href;
}

const SERVER_URL = withUserinfo(
  'http://127.0.0.1:8123/mcp?token=abc&empty=',
  'user',
  'secret',
);

const logExporter = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({exporter: logExporter})],
});
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
const contextManager = new AsyncLocalStorageContextManager();

interface JsonRpcRequest {
  id?: number;
  method: string;
  params?: {protocolVersion?: string};
}

/** A JSON-RPC MCP server behind `fetch`, answering over plain JSON. */
function createFakeMcpServerFetch() {
  return vi.fn(async (_url: string | URL, init?: FetchInit) => {
    if ((init?.method ?? 'GET') !== 'POST') {
      return new Response(null, {status: 405});
    }
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.id === undefined) {
      return new Response(null, {status: 202});
    }
    const headers = {
      'content-type': 'application/json',
      'mcp-session-id': 'session-abc',
    };
    if (request.method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: {tools: {}},
            serverInfo: {name: 'fake-server', version: '1.0.0'},
          },
        }),
        {status: 200, headers},
      );
    }
    return new Response(
      JSON.stringify({jsonrpc: '2.0', id: request.id, result: {tools: []}}),
      {status: 200, headers: {'content-type': 'application/json'}},
    );
  });
}

function exchangeRecords(): ReadableLogRecord[] {
  return logExporter
    .getFinishedLogRecords()
    .filter((record) => record.eventName === EVENT_NAME);
}

async function runSession(
  fetchImpl: ReturnType<typeof createFakeMcpServerFetch>,
): Promise<void> {
  const manager = new MCPSessionManager({
    type: 'StreamableHTTPConnectionParams',
    url: SERVER_URL,
    transportOptions: {fetch: fetchImpl},
  });
  const client = await manager.createSession();
  await client.listTools();
  await manager.closeSession(client);
}

describe('MCP HTTP exchange records', () => {
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(tracerProvider);
    logs.setGlobalLoggerProvider(loggerProvider);
  });

  afterAll(async () => {
    await loggerProvider.shutdown();
    await tracerProvider.shutdown();
    logs.disable();
    trace.disable();
    context.disable();
    contextManager.disable();
  });

  beforeEach(() => {
    logExporter.reset();
    spanExporter.reset();
    for (const name of [
      'ADK_EXPERIMENTAL_TELEMETRY',
      'ADK_EXPERIMENTAL_TELEMETRY_FEATURES',
      'ADK_CAPTURE_MCP_HTTP_BODIES',
      'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
      'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE',
    ]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('through MCPSessionManager', () => {
    it('emits nothing while reporting is off', async () => {
      const fetchImpl = createFakeMcpServerFetch();

      await runSession(fetchImpl);

      expect(fetchImpl).toHaveBeenCalled();
      expect(exchangeRecords()).toEqual([]);
    });

    it.each([
      ['ADK_EXPERIMENTAL_TELEMETRY', 'true'],
      ['ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'mcp'],
    ])(
      'emits one DEBUG record per exchange with %s=%s',
      async (name, value) => {
        vi.stubEnv(name, value);
        const fetchImpl = createFakeMcpServerFetch();

        await runSession(fetchImpl);

        const records = exchangeRecords();
        expect(records).toHaveLength(fetchImpl.mock.calls.length);
        for (const record of records) {
          expect(record.severityNumber).toBe(SeverityNumber.DEBUG);
          expect(record.body).toEqual({
            'http.request.body.content': '<elided>',
            'http.response.body.content': '<elided>',
          });
        }

        const [initialize, ...rest] = records;
        expect(initialize.attributes).toEqual({
          'http.request.method': 'POST',
          'url.full': 'http://127.0.0.1:8123/mcp?token=REDACTED',
          'http.response.status_code': 200,
          'server.address': '127.0.0.1',
          'server.port': 8123,
          'mcp.session.id': 'session-abc',
        });
        const listTools = rest.find(
          (record) =>
            record.attributes['http.request.method'] === 'POST' &&
            record.attributes['http.response.status_code'] === 200,
        );
        expect(listTools?.attributes).toMatchObject({
          'mcp.session.id': 'session-abc',
          'mcp.protocol.version': expect.any(String),
        });
        const sseAttempt = rest.find(
          (record) => record.attributes['http.request.method'] === 'GET',
        );
        expect(sseAttempt?.attributes).toMatchObject({
          'http.response.status_code': 405,
          'error.type': '405',
        });
      },
    );
  });

  describe('createObservedFetch', () => {
    async function observe(
      response: Response,
      init: FetchInit = {method: 'POST', body: '{}'},
      url = 'https://mcp.example.com/mcp',
    ): Promise<ReadableLogRecord> {
      const observed = createObservedFetch(async () => response);
      await observed(url, init);
      await vi.waitFor(() => {
        expect(exchangeRecords()).toHaveLength(1);
      });
      return exchangeRecords()[0];
    }

    it('sets error.type only for a status of 400 or more', async () => {
      const ok = await observe(new Response('{}', {status: 200}));
      logExporter.reset();
      const notFound = await observe(new Response('{}', {status: 404}));

      expect(ok.attributes).not.toHaveProperty('error.type');
      expect(notFound.attributes['error.type']).toBe('404');
      expect(notFound.attributes['http.response.status_code']).toBe(404);
    });

    it('omits server.port for the default port', async () => {
      const record = await observe(new Response('{}'));

      expect(record.attributes['server.address']).toBe('mcp.example.com');
      expect(record.attributes).not.toHaveProperty('server.port');
    });

    it('drops the brackets of an IPv6 server.address', async () => {
      const record = await observe(
        new Response('{}'),
        undefined,
        'http://[::1]:9000/mcp',
      );

      expect(record.attributes['server.address']).toBe('::1');
      expect(record.attributes['server.port']).toBe(9000);
    });

    describe('with ADK_CAPTURE_MCP_HTTP_BODIES', () => {
      beforeEach(() => {
        vi.stubEnv('ADK_CAPTURE_MCP_HTTP_BODIES', 'true');
      });

      it('records the bodies, cut at 1000 characters', async () => {
        const longBody = 'a'.repeat(1500);

        const record = await observe(new Response(longBody), {
          method: 'POST',
          body: '{"jsonrpc":"2.0"}',
        });

        expect(record.body).toEqual({
          'http.request.body.content': '{"jsonrpc":"2.0"}',
          'http.response.body.content': 'a'.repeat(1000) + '... [truncated]',
        });
      });

      it('cuts by code point, never splitting a surrogate pair', async () => {
        const body = 'b' + '😀'.repeat(1200);

        const record = await observe(new Response(body));

        const recorded = (record.body as Record<string, string>)[
          'http.response.body.content'
        ];
        expect(recorded).toBe('b' + '😀'.repeat(999) + '... [truncated]');
      });

      it('decodes a byte request body and marks other bodies as binary', async () => {
        const bytes = await observe(new Response(''), {
          method: 'POST',
          body: new TextEncoder().encode('{"id":1}'),
        });
        logExporter.reset();
        const blob = await observe(new Response(''), {
          method: 'POST',
          body: new Blob(['x']),
        });

        expect(bytes.body).toMatchObject({
          'http.request.body.content': '{"id":1}',
        });
        expect(blob.body).toMatchObject({
          'http.request.body.content': '<binary>',
        });
      });

      it('never reads an SSE response body', async () => {
        const response = new Response('data: {}\n\n', {
          headers: {'content-type': 'Text/Event-Stream; charset=utf-8'},
        });
        const clone = vi.spyOn(response, 'clone');
        const text = vi.spyOn(response, 'text');

        const record = await observe(response);

        expect(clone).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
        expect(response.bodyUsed).toBe(false);
        expect(record.body).toMatchObject({
          'http.response.body.content': '<SSE stream>',
        });
      });

      it('leaves the response body readable for the transport', async () => {
        const observed = createObservedFetch(
          async () => new Response('{"ok":true}'),
        );

        const response = await observed('https://mcp.example.com/mcp', {
          method: 'POST',
        });

        expect(await response.text()).toBe('{"ok":true}');
      });

      it('resolves the response before a streaming body finishes buffering', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        const observed = createObservedFetch(
          async () => new Response(stream, {status: 200}),
        );

        const response = await observed('https://mcp.example.com/mcp', {
          method: 'POST',
          body: '{"id":1}',
        });

        expect(exchangeRecords()).toHaveLength(0);
        controller.enqueue(new TextEncoder().encode('{"ok":true}'));
        controller.close();
        expect(await response.text()).toBe('{"ok":true}');
        await vi.waitFor(() => {
          expect(exchangeRecords()).toHaveLength(1);
        });
        expect(exchangeRecords()[0].body).toEqual({
          'http.request.body.content': '{"id":1}',
          'http.response.body.content': '{"ok":true}',
        });
      });
    });

    it('records only allowlisted headers, credentials redacted', async () => {
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_REQUEST',
        'Authorization, x-goog-api-key, x-custom-.*, (',
      );
      vi.stubEnv(
        'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_CLIENT_RESPONSE',
        'content-type,set-cookie',
      );
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const record = await observe(
        new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'id=secret',
            'X-Other': 'value',
          },
        }),
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer secret',
            'X-Goog-Api-Key': 'secret-key',
            'X-Custom-Trace': 'trace-1',
            'X-Not-Listed': 'value',
          },
        },
      );

      const headerAttributes = Object.fromEntries(
        Object.entries(record.attributes).filter(([key]) =>
          key.includes('.header.'),
        ),
      );
      expect(headerAttributes).toEqual({
        'http.request.header.authorization': ['<redacted>'],
        'http.request.header.x-goog-api-key': ['<redacted>'],
        'http.request.header.x-custom-trace': ['trace-1'],
        'http.response.header.content-type': ['application/json'],
        'http.response.header.set-cookie': ['<redacted>'],
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring malformed header pattern '('"),
      );
    });

    it('drops userinfo and redacts query values in url.full', async () => {
      const record = await observe(
        new Response('{}'),
        undefined,
        withUserinfo(
          'https://mcp.example.com/mcp?key=k1&key=k2&blank=&flag&q=a%20b',
          'alice',
          'pw',
        ),
      );

      expect(record.attributes['url.full']).toBe(
        'https://mcp.example.com/mcp?key=REDACTED&q=REDACTED',
      );
    });

    const sessionIdCases: Array<{
      source: string;
      url: string;
      responseHeaders: Record<string, string>;
      requestHeaders: Record<string, string>;
      expected: string;
    }> = [
      {
        source: 'the sessionId query of an SSE message endpoint',
        url: 'https://mcp.example.com/messages?sessionId=from-query',
        responseHeaders: {'mcp-session-id': 'from-response'},
        requestHeaders: {'mcp-session-id': 'from-request'},
        expected: 'from-query',
      },
      {
        source: 'the session_id query',
        url: 'https://mcp.example.com/messages?session_id=from-query',
        responseHeaders: {},
        requestHeaders: {},
        expected: 'from-query',
      },
      {
        source: 'the initialize response header',
        url: 'https://mcp.example.com/mcp',
        responseHeaders: {'mcp-session-id': 'from-response'},
        requestHeaders: {'mcp-session-id': 'from-request'},
        expected: 'from-response',
      },
      {
        source: 'the request header',
        url: 'https://mcp.example.com/mcp',
        responseHeaders: {},
        requestHeaders: {'mcp-session-id': 'from-request'},
        expected: 'from-request',
      },
    ];

    it.each(sessionIdCases)(
      'takes mcp.session.id from $source',
      async ({url, responseHeaders, requestHeaders, expected}) => {
        const record = await observe(
          new Response('{}', {headers: responseHeaders}),
          {method: 'POST', headers: requestHeaders},
          url,
        );

        expect(record.attributes['mcp.session.id']).toBe(expected);
      },
    );

    it('calls the caller fetch with the same arguments', async () => {
      const userFetch = vi.fn(async () => new Response('{}'));
      const init: FetchInit = {method: 'POST', body: '{}'};

      await createObservedFetch(userFetch)('https://mcp.example.com/mcp', init);

      expect(userFetch).toHaveBeenCalledWith(
        'https://mcp.example.com/mcp',
        init,
      );
    });

    it('propagates a fetch error unchanged and emits nothing', async () => {
      const failure = new TypeError('fetch failed');
      const observed = createObservedFetch(async () => {
        throw failure;
      });

      await expect(observed('https://mcp.example.com/mcp')).rejects.toBe(
        failure,
      );
      expect(exchangeRecords()).toEqual([]);
    });

    it('parents the record to the active execute_tool span', async () => {
      const observed = createObservedFetch(async () => new Response('{}'));

      const spanId = await trace
        .getTracer('test')
        .startActiveSpan('execute_tool my_tool', async (span) => {
          await observed('https://mcp.example.com/mcp', {method: 'POST'});
          span.end();
          return span.spanContext().spanId;
        });

      const [record] = exchangeRecords();
      expect(record.spanContext?.spanId).toBe(spanId);
    });
  });
});
