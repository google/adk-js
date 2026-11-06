/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {AgentRuntimeRequestHooks, Logger} from '@google/adk';
import express, {type NextFunction, type Request, type Response} from 'express';
import fc from 'fast-check';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {createAgentRuntimeMiddleware} from '../../src/server/agent_runtime_middleware.js';

interface RecordingHooks extends AgentRuntimeRequestHooks {
  readonly calls: string[];
  starts: number;
  ends: number;
}

/** Hooks that record their calls; `onRequestEnd` resolves after `delayMs`. */
function recordingHooks(
  options: {delayMs?: number; fail?: boolean} = {},
): RecordingHooks {
  const hooks: RecordingHooks = {
    calls: [],
    starts: 0,
    ends: 0,
    onRequestStart() {
      hooks.starts += 1;
      hooks.calls.push('start');
      if (options.fail) {
        throw new Error('start hook crashed');
      }
    },
    async onRequestEnd() {
      hooks.ends += 1;
      hooks.calls.push('end:begin');
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      hooks.calls.push('end:done');
      if (options.fail) {
        throw new Error('end hook crashed');
      }
    },
  };
  return hooks;
}

function silentLogger(): Logger {
  return {
    setLogLevel: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

interface TestServer {
  readonly port: number;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

async function listen(app: express.Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const testServer = {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(testServer);
  return testServer;
}

interface TestResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function request(
  port: number,
  path: string,
  method = 'GET',
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {host: '127.0.0.1', port, path, method, agent: false},
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({status: res.statusCode ?? 0, headers: res.headers, body}),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

function createApp(
  hooks: AgentRuntimeRequestHooks,
  logger: Logger = silentLogger(),
) {
  const app = express();
  app.use(createAgentRuntimeMiddleware({hooks, logger}));
  return app;
}

describe('createAgentRuntimeMiddleware', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('runs the start hook before the handler and finishes the end hook before finish', async () => {
    const hooks = recordingHooks({delayMs: 20});
    const app = createApp(hooks);
    app.get('/json', (_req: Request, res: Response) => {
      hooks.calls.push('handler');
      res.on('finish', () => hooks.calls.push('finish'));
      res.json({ok: true});
    });
    const {port} = await listen(app);

    const response = await request(port, '/json');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ok: true});
    expect(response.headers['content-length']).toBe(
      String(Buffer.byteLength(response.body)),
    );
    await waitFor(() => hooks.calls.includes('finish'));
    expect(hooks.calls).toEqual([
      'start',
      'handler',
      'end:begin',
      'end:done',
      'finish',
    ]);
  });

  it('delivers every streamed chunk and ends the request after the handler ends it', async () => {
    const hooks = recordingHooks({delayMs: 10});
    const app = createApp(hooks);
    app.get('/sse', async (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      for (const n of [1, 2, 3]) {
        res.write(`data: ${n}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        hooks.calls.push(`chunk ${n}`);
      }
      hooks.calls.push('handler end');
      res.end('data: done\n\n');
    });
    const {port} = await listen(app);

    const response = await request(port, '/sse');

    expect(response.body).toBe(
      'data: 1\n\ndata: 2\n\ndata: 3\n\ndata: done\n\n',
    );
    expect(hooks.calls).toEqual([
      'start',
      'chunk 1',
      'chunk 2',
      'chunk 3',
      'handler end',
      'end:begin',
      'end:done',
    ]);
  });

  it('writes the final chunk before waiting for the end hook', async () => {
    let releaseEnd: () => void = () => {};
    const hooks: AgentRuntimeRequestHooks = {
      onRequestStart: () => {},
      onRequestEnd: () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    };
    const app = createApp(hooks);
    app.get('/slow-end', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/plain');
      res.end('final chunk');
    });
    const {port} = await listen(app);

    const received = await new Promise<string>((resolve, reject) => {
      http
        .get(
          {host: '127.0.0.1', port, path: '/slow-end', agent: false},
          (res) => {
            res.setEncoding('utf8');
            res.once('data', (chunk: string) => resolve(chunk));
          },
        )
        .on('error', reject);
    });
    releaseEnd();

    expect(received).toContain('final chunk');
  });

  it('ends the request once when the handler throws', async () => {
    const hooks = recordingHooks();
    const app = createApp(hooks);
    app.get('/throws', () => {
      throw new Error('handler crashed');
    });
    const {port} = await listen(app);

    const response = await request(port, '/throws');

    expect(response.status).toBe(500);
    expect(hooks.starts).toBe(1);
    expect(hooks.ends).toBe(1);
  });

  it('ends the request once when the handler passes an error on', async () => {
    const hooks = recordingHooks();
    const app = createApp(hooks);
    app.get(
      '/next-error',
      (_req: Request, _res: Response, next: NextFunction) => {
        setTimeout(() => next(new Error('async failure')), 5);
      },
    );
    const {port} = await listen(app);

    const response = await request(port, '/next-error');

    expect(response.status).toBe(500);
    expect(hooks.ends).toBe(1);
  });

  it('ends the request once when the client goes away mid-stream', async () => {
    const hooks = recordingHooks();
    const app = createApp(hooks);
    let lateEnd: () => void = () => {};
    app.get('/abort', (_req: Request, res: Response) => {
      res.write('data: first\n\n');
      lateEnd = () => res.end();
    });
    const {port} = await listen(app);

    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {host: '127.0.0.1', port, path: '/abort', agent: false},
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => {});
      req.on('close', () => resolve());
      setTimeout(() => reject(new Error('no data received')), 2000);
    });
    await waitFor(() => hooks.ends === 1);
    lateEnd();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hooks.ends).toBe(1);
  });

  it('handles HEAD and 204 responses', async () => {
    const hooks = recordingHooks();
    const app = createApp(hooks);
    app.get('/text', (_req: Request, res: Response) => {
      res.send('hello');
    });
    app.delete('/empty', (_req: Request, res: Response) => {
      res.status(204).end();
    });
    const {port} = await listen(app);

    const head = await request(port, '/text', 'HEAD');
    const empty = await request(port, '/empty', 'DELETE');

    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('5');
    expect(empty.status).toBe(204);
    expect(empty.body).toBe('');
    expect(hooks.ends).toBe(2);
  });

  it('delivers the full response when both hooks fail', async () => {
    const hooks = recordingHooks({fail: true});
    const logger = silentLogger();
    const app = createApp(hooks, logger);
    app.get('/json', (_req: Request, res: Response) => {
      res.json({ok: true});
    });
    const {port} = await listen(app);

    const response = await request(port, '/json');

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ok: true});
    await waitFor(() => vi.mocked(logger.warn).mock.calls.length === 2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Telemetry request-start hook failed.',
      expect.any(Error),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Telemetry request-end hook failed.',
      expect.any(Error),
    );
  });

  it('balances request starts and ends over any mix of concurrent outcomes', async () => {
    const hooks = recordingHooks({delayMs: 1});
    const app = createApp(hooks);
    app.get('/ok', (_req: Request, res: Response) => {
      res.send('ok');
    });
    app.get('/stream', async (_req: Request, res: Response) => {
      res.write('a');
      await new Promise((resolve) => setTimeout(resolve, 2));
      res.end('b');
    });
    app.get('/throws', () => {
      throw new Error('handler crashed');
    });
    app.get(
      '/next-error',
      (_req: Request, _res: Response, next: NextFunction) => {
        setTimeout(() => next(new Error('async failure')), 1);
      },
    );
    const {port} = await listen(app);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('/ok', '/stream', '/throws', '/next-error'), {
          minLength: 1,
          maxLength: 8,
        }),
        async (paths) => {
          hooks.starts = 0;
          hooks.ends = 0;
          await Promise.all(paths.map((path) => request(port, path)));
          await waitFor(() => hooks.ends === paths.length);

          expect(hooks.starts).toBe(paths.length);
          expect(hooks.ends).toBe(paths.length);
        },
      ),
      {seed: 20260611, numRuns: 25},
    );
  });
});
