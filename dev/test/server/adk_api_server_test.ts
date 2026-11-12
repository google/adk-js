/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import * as adk from '@google/adk';
import {
  App,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  createEvent,
  createSession,
  EVAL_SESSION_ID_PREFIX,
  EvalStatus,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  INTERNAL_METADATA_PREFIX,
  InvocationContext,
  LlmAgent,
  LocalEvalSetResultsManager,
  LocalEvalSetsManager,
  node,
  RESTORED_EVENT_KEY,
  Runner,
  Session,
  StreamingMode,
  Workflow,
} from '@google/adk';
import {context, type SpanContext, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {emptyResource} from '@opentelemetry/resources';
import {ReadableSpan, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import {z} from 'zod';

import {
  A2A_AUTH_TOKEN_ENV_VAR,
  AdkApiServer,
} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {AdkLogger} from '../../src/utils/logger.js';
import {version} from '../../src/version.js';

interface JsonRpcResponse {
  result?: unknown;
  error?: {code: number; message: string};
}

/**
 * Sends a genuine A2A `message/send` JSON-RPC call, optionally with an
 * `Authorization` header and extra headers, and reports the raw HTTP status so
 * authentication failures can be told apart from agent responses.
 */
async function sendA2aMessage(
  baseUrl: string,
  authorization?: string,
  headers: Record<string, string> = {},
): Promise<{status: number; body: JsonRpcResponse}> {
  const response = await fetch(`${baseUrl}/a2a/testApp/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? {Authorization: authorization} : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'a2a-test-request',
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'a2a-test-message',
          role: 'user',
          parts: [{kind: 'text', text: 'Hello'}],
        },
      },
    }),
  });

  return {
    status: response.status,
    body: (await response.json()) as JsonRpcResponse,
  };
}

/**
 * Http client for testing the AdkWebServer. It makes real http requests to the
 * server.
 */
class HttpClient {
  constructor(private readonly baseUrl: string) {}

  get<T>(url: string) {
    return this.request<T>(url, {method: 'GET'});
  }

  post<T>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>(url, {method: 'POST', body, headers});
  }

  put<T>(url: string, body?: unknown) {
    return this.request<T>(url, {method: 'PUT', body});
  }

  delete<T>(url: string) {
    return this.request<T>(url, {method: 'DELETE'});
  }

  private async request<T = unknown>(
    url: string,
    {
      method,
      body,
      headers,
    }: {method: string; body?: unknown; headers?: Record<string, string>},
  ): Promise<{status: number; data?: T; text?: string}> {
    const options = {
      method,
      headers: body
        ? {'Content-Type': 'application/json', ...headers}
        : headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual' as const,
    };

    const response = await fetch(`${this.baseUrl}${url}`, options);
    const contentType = response.headers.get('content-type');
    let data: T | undefined = undefined;
    let text: string | undefined = undefined;

    if (contentType?.includes('application/json')) {
      data = (await response.json().catch(() => undefined)) as T;
    } else {
      text = await response.text();
    }

    if (response.status > 399) {
      throw {
        response: {status: response.status, data, text},
        message: (data as {error?: string})?.error || response.statusText,
      };
    }

    return {
      status: response.status,
      data,
      text,
    };
  }
}

class TestAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: "Hello user! I'm streaming you events now!",
          },
        ],
        role: 'model',
      },
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'Event 1',
          },
        ],
        role: 'model',
      },
    });

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'Event 2',
          },
        ],
        role: 'model',
      },
    });

    return;
  }

  async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        parts: [
          {
            text: 'test live content',
          },
        ],
        role: 'model',
      },
    });
  }
}

const TEST_AGENT = new TestAgent({
  name: 'testAgent',
  description: 'test agent',
  tools: [
    new FunctionTool({
      name: 'foo',
      description: 'foo tool',
      parameters: z.object({}),
      execute: async () => 'bar',
    }),
  ],
});

describe('AdkWebServer', () => {
  let agentLoader: AgentLoader;
  let sessionService: BaseSessionService;
  let memoryService: BaseMemoryService;
  let artifactService: BaseArtifactService;
  let server: AdkApiServer;
  let client: HttpClient;

  beforeEach(async () => {
    agentLoader = {
      listAgents: () => Promise.resolve(['testApp']),
      getAgentFile: () =>
        Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load() {
            return Promise.resolve(TEST_AGENT);
          },
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        }),
    } as unknown as AgentLoader;
    sessionService = new InMemorySessionService();
    memoryService = new InMemoryMemoryService();
    artifactService = new InMemoryArtifactService();
    server = new AdkApiServer({
      agentLoader,
      sessionService,
      memoryService,
      artifactService,
    });
    await server.start();

    client = new HttpClient(server.url);
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Version', () => {
    it('reports the ADK version the server is running', async () => {
      const response = await client.get<{version: string}>('/version');

      expect(response.status).toBe(200);
      expect(response.data?.version).toBe(version);
      expect(response.data?.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  /**
   * Sends a GET with an explicit Host header, bypassing whatever Host `url`'s
   * hostname would otherwise imply. `fetch()` cannot do this: undici rewrites
   * Host to match the actual connection target for any request it dispatches,
   * which is exactly why the DNS-rebinding guard below has to be tested with
   * a lower-level client that reproduces what a rebound page's browser
   * actually sends on the wire.
   */
  function getWithHost(url: string, hostHeader: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'GET',
          headers: {Host: hostHeader},
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  describe('DNS-rebinding guard', () => {
    // Regression tests for a missing DNS-rebinding guard: the server bound
    // to loopback with no --allow_origins configured accepted requests
    // naming an arbitrary Host, which a page reached via a rebound hostname
    // would send. Origin cannot catch this -- browsers omit it on requests
    // they consider same-origin, as a rebound page's are -- so the guard
    // must key off Host instead, on every method including GET.
    let guardServer: AdkApiServer;

    beforeEach(async () => {
      guardServer = new AdkApiServer({
        agentLoader: {
          listAgents: () => Promise.resolve(['testApp']),
        } as unknown as AgentLoader,
      });
      await guardServer.start();
    });

    afterEach(async () => {
      await guardServer.stop();
    });

    it('accepts a request whose Host names the loopback bind', async () => {
      const status = await getWithHost(
        `${guardServer.url}/version`,
        'localhost',
      );
      expect(status).toBe(200);
    });

    it('rejects a GET whose Host does not name loopback', async () => {
      const status = await getWithHost(
        `${guardServer.url}/version`,
        'evil.attacker.example',
      );
      expect(status).toBe(403);
    });

    it('rejects a read endpoint with no Origin header at all', async () => {
      // The exact shape of a DNS-rebound page's request: same-origin as far
      // as the browser is concerned, so no Origin header is sent.
      const status = await getWithHost(
        `${guardServer.url}/list-apps`,
        'evil.attacker.example',
      );
      expect(status).toBe(403);
    });
  });

  describe('Sessions', () => {
    it('should return an empty list of sessions', async () => {
      const response = await client.get<{
        sessions: Session[];
      }>('/apps/testApp/users/testUser/sessions');

      expect(response.status).toBe(200);
      expect(response.data?.sessions).toEqual([]);
    });

    it('should create a session with a random id', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions',
        {},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toBeDefined();
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
    });

    it('should create a session with a given id', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
        {},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
    });

    it('should create a session with a given id and state', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
        {state: {foo: 'bar'}},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
      expect(response.data?.state).toEqual({foo: 'bar'});
    });

    it('should create a session with random id and state', async () => {
      const response = await client.post<Session>(
        '/apps/testApp/users/testUser/sessions',
        {state: {foo: 'bar'}},
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toBeDefined();
      expect(response.data?.appName).toEqual('testApp');
      expect(response.data?.userId).toEqual('testUser');
      expect(response.data?.state).toEqual({foo: 'bar'});
    });

    it('should return 400 if session with given id already exists', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post(
          '/apps/testApp/users/testUser/sessions/sessionId',
          {},
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(400);
      }
    });

    it('should return a session by id', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.get<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
      );

      expect(response.status).toBe(200);
      expect(response.data?.id).toEqual('sessionId');
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.get('/apps/testApp/users/testUser/sessions/sessionId');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should delete a session', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.delete(
        '/apps/testApp/users/testUser/sessions/sessionId',
      );

      expect(response.status).toBe(204);
      expect(
        await sessionService.getSession({
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
        }),
      ).toBeUndefined();
    });
  });

  describe('Artifacts', () => {
    it('should return an empty list of artifacts', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual([]);
    });

    it('should return an artifact by name', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        text: 'content',
      });
    });

    it('should return 404 if artifact not found', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return an artifact by version', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.get(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt/versions/0',
      );

      expect(response.status).toBe(200);
      expect(response.data).toEqual({text: 'content'});
    });

    it('should return a list of artifact versions', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content2',
        },
      });

      const response = await client.get<string[]>(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt/versions',
      );

      expect(response.status).toBe(200);
      expect(response.data?.length).toEqual(2);
    });

    it('should delete an artifact', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'artifact.txt',
        artifact: {
          text: 'content',
        },
      });

      const response = await client.delete(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/artifact.txt',
      );

      expect(response.status).toBe(204);
      expect(
        await artifactService.loadArtifact({
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          filename: 'artifact.txt',
        }),
      ).toBeUndefined();
    });
  });

  describe('run', () => {
    it('should return a list of events', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data!.length).toBe(3);
      expect((response.data as Event[])[0].content!.parts![0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('should find session in /run when exported App.name differs from route appName', async () => {
      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load() {
            return Promise.resolve(
              new App({name: 'real_name', rootAgent: TEST_AGENT}),
            );
          },
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        })) as unknown as AgentLoader['getAgentFile'];

      await client.post<Session>(
        '/apps/my_file/users/testUser/sessions/sessionId',
        {},
      );

      const response = await client.post<Event[]>('/run', {
        appName: 'my_file',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data!.length).toBe(3);
    });

    it('should update session state if stateDelta is provided', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        state: {foo: 'bar'},
      });

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
        stateDelta: {baz: 'qux'},
      });

      expect(response.status).toBe(200);
      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      // The state should be merged or updated. Assuming deep merge or at least key addition.
      // If Runner does shallow merge of stateDelta:
      expect(session?.state).toEqual({foo: 'bar', baz: 'qux'});
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {parts: [{text: 'Hello'}], role: 'user'},
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });

    it('should return the events a failed invocation produced', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load: () =>
            Promise.resolve(
              new Workflow({
                name: 'wf',
                edges: [
                  [
                    'START',
                    node(async () => 'ok', {name: 'first'}),
                    node(
                      async () => {
                        throw new Error('boom');
                      },
                      {name: 'second'},
                    ),
                  ],
                ],
              }),
            ),
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        })) as unknown as AgentLoader['getAgentFile'];

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'failSession',
      });

      let status: number | undefined;
      let body: {error: string; events: Event[]} | undefined;
      try {
        await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'failSession',
          newMessage: {parts: [{text: 'Hello'}], role: 'user'},
        });
      } catch (e: unknown) {
        const response = (e as {response: {status: number; data: typeof body}})
          .response;
        status = response.status;
        body = response.data;
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }

      expect(status).toBe(500);
      expect(body?.error).toContain('Failed to run agent');
      expect(body?.events.some((e) => e.author === 'first')).toBe(true);
      const nodeError = body?.events.find(
        (e) => (e as Event & {isNodeError?: boolean}).isNodeError,
      );
      expect(nodeError?.nodeInfo?.path).toBe('wf.second');
    });

    it('should pass abortSignal to Runner.runAsync in /run', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      const runAsyncParams = spy.mock.calls[0][0];
      expect(runAsyncParams.abortSignal).toBeDefined();
      expect(runAsyncParams.abortSignal).toBeInstanceOf(AbortSignal);

      spy.mockRestore();
    });

    it('forwards customMetadata from the request body to Runner.runAsync', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
        customMetadata: {requestId: 'abc-123', tenant: 'acme'},
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].customMetadata).toEqual({
        requestId: 'abc-123',
        tenant: 'acme',
      });

      spy.mockRestore();
    });

    it('leaves customMetadata undefined when the body omits it', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].customMetadata).toBeUndefined();

      spy.mockRestore();
    });

    it('stamps customMetadata onto the user message event persisted in the session', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
        customMetadata: {requestId: 'abc-123'},
      });

      expect(response.status).toBe(200);
      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      const userEvent = session?.events.find((e) => e.author === 'user');
      expect(userEvent?.customMetadata).toEqual({requestId: 'abc-123'});
    });
  });

  describe('ADK-internal customMetadata', () => {
    const INTERNAL_KEY = `${INTERNAL_METADATA_PREFIX}stamp`;
    const runBody = {
      appName: 'testApp',
      userId: 'testUser',
      sessionId: 'sessionId',
      newMessage: {parts: [{text: 'Hello'}], role: 'user'},
    };

    beforeEach(async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
    });

    it('is hidden from session endpoints but kept in storage', async () => {
      const session = (await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      }))!;
      await sessionService.appendEvent({
        session,
        event: createEvent({
          author: 'user',
          customMetadata: {keep: 1, [RESTORED_EVENT_KEY]: true},
        }),
      });

      const fetched = await client.get<Session>(
        '/apps/testApp/users/testUser/sessions/sessionId',
      );
      const listed = await client.get<{sessions: Session[]}>(
        '/apps/testApp/users/testUser/sessions',
      );

      expect(fetched.data?.events[0].customMetadata).toEqual({keep: 1});
      const listedSession = listed.data?.sessions.find(
        (s) => s.id === 'sessionId',
      );
      // The in-memory service lists sessions without events; others may not.
      for (const event of listedSession?.events ?? []) {
        expect(event.customMetadata).toEqual({keep: 1});
      }
      const stored = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      expect(stored?.events[0].customMetadata).toEqual({
        keep: 1,
        [RESTORED_EVENT_KEY]: true,
      });
    });

    it.each(['/run', '/run_sse'])(
      'is hidden from events streamed by %s',
      async (endpoint) => {
        const spy = vi
          .spyOn(Runner.prototype, 'runAsync')
          .mockImplementation(async function* () {
            yield createEvent({
              author: 'testAgent',
              content: {role: 'model', parts: [{text: 'reply'}]},
              customMetadata: {keep: 1, [INTERNAL_KEY]: 'x'},
            });
          });

        const response = await client.post<Event[]>(endpoint, runBody);

        const events =
          endpoint === '/run'
            ? response.data!
            : response
                .text!.split('\n')
                .filter((line) => line.startsWith('data: '))
                .map(
                  (line) => JSON.parse(line.slice('data: '.length)) as Event,
                );
        expect(events.map((e) => e.customMetadata)).toEqual([{keep: 1}]);
        spy.mockRestore();
      },
    );
  });

  describe('run_sse', () => {
    it('should return a stream of events', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
      });

      const rawEvent = response.text!.split('\n\n');
      // Last element is always empty.
      rawEvent.pop();

      const events = rawEvent.map(
        (eventText) => JSON.parse(eventText.split('data: ')[1]) as Event,
      );

      expect(response.status).toBe(200);
      expect(events.length).toBe(3);
      expect(events[0]!.content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
      expect(events[1]!.content?.parts?.[0].text).toBe('Event 1');
      expect(events[2]!.content?.parts?.[0].text).toBe('Event 2');
    });

    it('should update session state if stateDelta is provided', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        state: {foo: 'bar'},
      });

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [
            {
              text: 'Hello test agent!',
            },
          ],
          role: 'user',
        },
        stateDelta: {baz: 'qux'},
      });

      expect(response.status).toBe(200);
      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      expect(session?.state).toEqual({foo: 'bar', baz: 'qux'});
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.post('/run_sse', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      try {
        await client.post('/run_sse', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: {parts: [{text: 'Hello'}], role: 'user'},
        });
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });

    it('should pass abortSignal to Runner.runAsync in /run_sse', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalled();
      const runAsyncParams = spy.mock.calls[0][0];
      expect(runAsyncParams.abortSignal).toBeDefined();
      expect(runAsyncParams.abortSignal).toBeInstanceOf(AbortSignal);

      spy.mockRestore();
    });

    it('forwards customMetadata from the request body to Runner.runAsync', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post('/run_sse', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: {
          parts: [{text: 'Hello test agent!'}],
          role: 'user',
        },
        streaming: true,
        customMetadata: {requestId: 'abc-123', tenant: 'acme'},
      });

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const runAsyncParams = spy.mock.calls[0][0];
      expect(runAsyncParams.customMetadata).toEqual({
        requestId: 'abc-123',
        tenant: 'acme',
      });
      // The metadata travels beside runConfig, so streaming is unaffected.
      expect(runAsyncParams.runConfig?.streamingMode).toBe(StreamingMode.SSE);

      spy.mockRestore();
    });
  });

  describe('List Apps', () => {
    it('should return list of apps', async () => {
      const response = await client.get<string[]>('/list-apps');
      expect(response.status).toBe(200);
      expect(response.data).toEqual(['testApp']);
    });

    it('should return 500 if listAgents fails', async () => {
      const originalListAgents = agentLoader.listAgents;
      agentLoader.listAgents = () => Promise.reject(new Error('List failed'));

      try {
        await client.get('/list-apps');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.listAgents = originalListAgents;
      }
    });
  });

  describe('Debug UI', () => {
    it('should redirect / and /dev-ui to /dev-ui/ when enabled', async () => {
      const browserDir = path.resolve(__dirname, '../../browser');
      const createdBrowserDir = !fs.existsSync(browserDir);
      const indexFile = path.join(browserDir, 'index.html');
      const createdIndexFile = !fs.existsSync(indexFile);
      if (createdBrowserDir) {
        fs.mkdirSync(browserDir, {recursive: true});
      }
      if (createdIndexFile) {
        fs.writeFileSync(indexFile, '<app-root></app-root>', 'utf-8');
      }

      const debugServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        serveDebugUI: true,
      });
      await debugServer.start();

      try {
        const rootRes = await fetch(`${debugServer.url}/`, {
          redirect: 'manual',
        });
        expect(rootRes.status).toBe(302);
        expect(rootRes.headers.get('location')).toBe('/dev-ui/');

        const devUiRes = await fetch(`${debugServer.url}/dev-ui`, {
          redirect: 'manual',
        });
        expect([301, 302]).toContain(devUiRes.status);
        expect(devUiRes.headers.get('location')).toBe('/dev-ui/');

        const devUiSlashRes = await fetch(`${debugServer.url}/dev-ui/`, {
          redirect: 'manual',
        });
        expect(devUiSlashRes.status).toBe(200);
      } finally {
        await debugServer.stop();
        if (createdBrowserDir) {
          fs.rmSync(browserDir, {recursive: true, force: true});
        } else if (createdIndexFile) {
          fs.rmSync(indexFile, {force: true});
        }
      }
    });
  });

  describe('Debug Trace', () => {
    it('should return trace by event id', async () => {
      (server as unknown as {traceDict: {[key: string]: unknown}}).traceDict[
        'event1'
      ] = {some: 'trace'};

      const response = await client.get<{some: string}>('/debug/trace/event1');
      expect(response.status).toBe(200);
      expect(response.data).toEqual({some: 'trace'});
    });

    it('should return 404 for missing trace', async () => {
      try {
        await client.get('/debug/trace/missing');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return session traces', async () => {
      const mockSpan = {
        name: 'call_llm',
        spanContext: () => ({traceId: 'trace1', spanId: 'span1'}),
        startTime: [1, 0],
        endTime: [2, 0],
        attributes: {'gcp.vertex.agent.session_id': 'session1'},
        parentSpanContext: undefined,
      } as unknown as ReadableSpan;

      (
        server as unknown as {
          memoryExporter: {
            export: (
              spans: ReadableSpan[],
              resultCallback: (result: {code: number}) => void,
            ) => void;
          };
        }
      ).memoryExporter.export([mockSpan], () => {});

      const response = await client.get<{name: string}[]>(
        '/debug/trace/session/session1',
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
      expect(response.data![0].name).toBe('call_llm');
    });

    // The dev UI asks for traces under `/dev/apps/<app>/`; the same store
    // answers, since a trace is keyed by event and session id alone.
    it('serves the same traces under the dev UI prefix', async () => {
      (server as unknown as {traceDict: {[key: string]: unknown}}).traceDict[
        'event2'
      ] = {some: 'prefixed trace'};
      const mockSpan = {
        name: 'call_llm',
        spanContext: () => ({traceId: 'trace2', spanId: 'span2'}),
        startTime: [1, 0],
        endTime: [2, 0],
        attributes: {'gcp.vertex.agent.session_id': 'session2'},
        parentSpanContext: undefined,
      } as unknown as ReadableSpan;
      (
        server as unknown as {
          memoryExporter: {
            export: (
              spans: ReadableSpan[],
              resultCallback: (result: {code: number}) => void,
            ) => void;
          };
        }
      ).memoryExporter.export([mockSpan], () => {});

      const event = await client.get<{some: string}>(
        '/dev/apps/testApp/debug/trace/event2',
      );
      const session = await client.get<{name: string}[]>(
        '/dev/apps/testApp/debug/trace/session/session2',
      );

      expect(event.status).toBe(200);
      expect(event.data).toEqual({some: 'prefixed trace'});
      expect(session.status).toBe(200);
      expect(session.data![0].name).toBe('call_llm');
    });

    it('serves traces for a workflow with no LLM span', async () => {
      const workflowSpan = {
        name: 'invoke_workflow wf',
        spanContext: () => ({traceId: 'trace3', spanId: 'span3'}),
        startTime: [1, 0],
        endTime: [2, 0],
        attributes: {'gen_ai.conversation.id': 'session3'},
        parentSpanContext: undefined,
      } as unknown as ReadableSpan;
      const nodeSpan = {
        name: 'execute_node wf.one',
        spanContext: () => ({traceId: 'trace3', spanId: 'span4'}),
        startTime: [1, 0],
        endTime: [2, 0],
        attributes: {'adk.node.path': 'wf.one'},
        parentSpanContext: {spanId: 'span3'},
      } as unknown as ReadableSpan;
      (
        server as unknown as {
          memoryExporter: {
            export: (
              spans: ReadableSpan[],
              resultCallback: (result: {code: number}) => void,
            ) => void;
          };
        }
      ).memoryExporter.export([workflowSpan, nodeSpan], () => {});

      const response = await client.get<{name: string}[]>(
        '/debug/trace/session/session3',
      );

      expect(response.status).toBe(200);
      expect(response.data!.map((s) => s.name)).toEqual([
        'invoke_workflow wf',
        'execute_node wf.one',
      ]);
    });
  });

  describe('Graph', () => {
    it('should return graph for function calls', async () => {
      const originalGetSession = sessionService.getSession;
      sessionService.getSession = async () =>
        createSession({
          id: 'fullSession',
          appName: 'testApp',
          userId: 'testUser',
          events: [
            createEvent({
              id: 'event1',
              author: 'model',
              content: {parts: [{functionCall: {name: 'foo', args: {}}}]},
              invocationId: 'inv-1',
            }),
          ],
        });

      try {
        const response = await client.get<{
          dotSrc: string;
        }>(
          '/apps/testApp/users/testUser/sessions/fullSession/events/event1/graph',
        );

        expect(response.status).toBe(200);
        expect(response.data!.dotSrc).toBeDefined();
        expect(response.data!.dotSrc).toContain('testAgent');
        expect(response.data!.dotSrc).toContain('foo');
      } finally {
        sessionService.getSession = originalGetSession;
      }
    });

    it('should highlight the workflow node that produced the event', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      const originalGetSession = sessionService.getSession;
      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load: () =>
            Promise.resolve(
              new Workflow({
                name: 'wf',
                edges: [
                  [
                    'START',
                    node(async () => 'a', {name: 'one'}),
                    node(async () => 'b', {name: 'two'}),
                  ],
                ],
              }),
            ),
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        })) as unknown as AgentLoader['getAgentFile'];
      sessionService.getSession = async () =>
        createSession({
          id: 'workflowSession',
          appName: 'testApp',
          userId: 'testUser',
          events: [
            createEvent({
              id: 'wfEvent1',
              author: 'one',
              invocationId: 'inv-1',
              nodeInfo: {path: 'wf.one'},
            }),
            createEvent({
              id: 'wfEvent2',
              author: 'two',
              invocationId: 'inv-1',
              nodeInfo: {path: 'wf.two'},
            }),
          ],
        });

      try {
        const response = await client.get<{dotSrc: string}>(
          '/apps/testApp/users/testUser/sessions/workflowSession/events/wfEvent2/graph',
        );

        expect(response.status).toBe(200);
        expect(response.data!.dotSrc).toContain('"wf.one" -> "wf.two"');
        expect(response.data!.dotSrc).toContain('#69CB87');
        expect(response.data!.dotSrc).toContain('#0F5223');
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
        sessionService.getSession = originalGetSession;
      }
    });

    it('should return 404 if session not found', async () => {
      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/missing/events/event1/graph',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    it('should return 404 if event not found', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionNoEvents',
      });
      try {
        await client.get(
          '/apps/testApp/users/testUser/sessions/sessionNoEvents/events/missing/graph',
        );
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });
  });

  describe('Structure graph', () => {
    /** Points the loader at `agent` for the rest of the test. */
    function loadInstead(agent: unknown, readme?: string) {
      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load: () => Promise.resolve(agent),
          readReadme: () => Promise.resolve(readme),
          async [Symbol.asyncDispose](): Promise<void> {
            return;
          },
        })) as unknown as AgentLoader['getAgentFile'];
    }

    /** A workflow nesting another workflow, to exercise per-level paths. */
    function nestedWorkflow() {
      const inner = new Workflow({
        name: 'inner',
        edges: [['START', node(async () => 'b', {name: 'inner_step'})]],
      });

      return new Workflow({
        name: 'outer',
        edges: [['START', node(async () => 'a', {name: 'outer_step'}), inner]],
      });
    }

    describe('build_graph', () => {
      it('serializes the agent tree, its tools and its sub-agents', async () => {
        const child = new LlmAgent({name: 'child', description: 'a child'});
        loadInstead(
          new LlmAgent({
            name: 'parent',
            tools: [
              new FunctionTool({
                name: 'lookup',
                description: 'lookup',
                execute: async () => 'ok',
              }),
            ],
            subAgents: [child],
          }),
        );

        const response = await client.get<{
          name: string;
          root_agent: {
            name: string;
            type: string;
            tools?: Array<{name: string}>;
            sub_agents?: Array<{name: string}>;
          };
        }>('/dev/apps/testApp/build_graph');

        expect(response.status).toBe(200);
        expect(response.data?.name).toBe('testApp');
        expect(response.data?.root_agent.name).toBe('parent');
        expect(response.data?.root_agent.type).toBe('agent');
        expect(response.data?.root_agent.tools).toEqual([
          {name: 'lookup', type: 'tool'},
        ]);
        expect(response.data?.root_agent.sub_agents).toEqual([
          expect.objectContaining({name: 'child', description: 'a child'}),
        ]);
      });

      it('includes the README.md the agent file resolves', async () => {
        loadInstead(
          new LlmAgent({name: 'documented'}),
          '# Sample\n\nWhat it shows.\n',
        );

        const response = await client.get<{readme?: string}>(
          '/dev/apps/testApp/build_graph',
        );

        expect(response.status).toBe(200);
        expect(response.data?.readme).toBe('# Sample\n\nWhat it shows.\n');
      });

      it('omits readme when the agent file resolves none', async () => {
        loadInstead(new LlmAgent({name: 'undocumented'}));

        const response = await client.get<{name: string; readme?: string}>(
          '/dev/apps/testApp/build_graph',
        );

        expect(response.status).toBe(200);
        expect(response.data?.name).toBe('testApp');
        expect(response.data?.readme).toBeUndefined();
      });

      // A workflow keeps its structure in its edges, so a serializer that only
      // walks `subAgents` reports an empty tree for it — the same trap the DOT
      // renderer hit before it learned to walk `edges`.
      it('serializes a workflow from its edges rather than its sub-agents', async () => {
        loadInstead(nestedWorkflow());

        const response = await client.get<{
          root_agent: {
            name: string;
            type: string;
            graph?: {
              nodes: Array<{name: string; type: string}>;
              edges: Array<{
                from_node: {name: string};
                to_node: {name: string};
              }>;
            };
          };
        }>('/dev/apps/testApp/build_graph');

        expect(response.status).toBe(200);
        const root = response.data!.root_agent;
        expect(root.type).toBe('workflow');
        expect(root.graph?.nodes.map((n) => n.name)).toEqual([
          '__START__',
          'outer_step',
          'inner',
        ]);
        expect(root.graph?.nodes.find((n) => n.name === 'inner')?.type).toBe(
          'workflow',
        );
        expect(
          root.graph?.edges.map((e) => [e.from_node.name, e.to_node.name]),
        ).toEqual([
          ['__START__', 'outer_step'],
          ['outer_step', 'inner'],
        ]);
      });

      it('returns 404 for an app that does not exist', async () => {
        await expect(
          client.get('/dev/apps/nope/build_graph'),
        ).rejects.toMatchObject({response: {status: 404}});
      });
    });

    describe('build_graph_image', () => {
      it('returns the DOT for the app, keyed by level and at the top level', async () => {
        const response = await client.get<
          Record<string, unknown> & {dotSrc?: string}
        >('/dev/apps/testApp/build_graph_image');

        expect(response.status).toBe(200);
        // The UI preloads every level from the map, but reads `dotSrc` on the
        // single-level fetch it falls back to, so both have to be present.
        expect(response.data?.dotSrc).toContain('digraph');
        expect(response.data?.['']).toEqual({
          dotSrc: expect.stringContaining('testAgent'),
        });
      });

      // The click handler matches a node's `<title>` against a bare child name,
      // so a qualified `parent.child` id would render but never be clickable.
      it('names nodes so the UI can match them to a child', async () => {
        loadInstead(nestedWorkflow());

        const response = await client.get<{dotSrc: string}>(
          '/dev/apps/testApp/build_graph_image',
        );

        expect(response.data?.dotSrc).toContain('"outer_step"');
        expect(response.data?.dotSrc).toContain('"inner"');
        expect(response.data?.dotSrc).not.toContain('"outer.outer_step"');
      });

      it('returns one entry per nested workflow, keyed by its path', async () => {
        loadInstead(nestedWorkflow());

        const response = await client.get<Record<string, {dotSrc: string}>>(
          '/dev/apps/testApp/build_graph_image',
        );

        expect(Object.keys(response.data!).sort()).toEqual([
          '',
          'dotSrc',
          'inner',
        ]);
        expect(response.data!['inner'].dotSrc).toContain('inner_step');
        expect(response.data!['inner'].dotSrc).not.toContain('outer_step');
      });

      it('returns just the requested level for a node path', async () => {
        loadInstead(nestedWorkflow());

        const response = await client.get<
          Record<string, unknown> & {dotSrc?: string}
        >('/dev/apps/testApp/build_graph_image?node=inner');

        expect(Object.keys(response.data!).sort()).toEqual(['dotSrc', 'inner']);
        expect(response.data?.dotSrc).toContain('inner_step');
      });

      it('draws each theme with its own palette', async () => {
        const light = await client.get<{dotSrc: string}>(
          '/dev/apps/testApp/build_graph_image?dark_mode=false',
        );
        const dark = await client.get<{dotSrc: string}>(
          '/dev/apps/testApp/build_graph_image?dark_mode=true',
        );

        expect(light.data?.dotSrc).toContain('bgcolor = "#F8FAFC"');
        expect(dark.data?.dotSrc).toContain('bgcolor = "#0F172A"');
      });

      // A dynamic workflow builds its nodes as it runs, so it has no static
      // graph to expand. It still has to draw as something.
      it('draws a dynamic workflow as a single node', async () => {
        loadInstead(
          new Workflow({
            name: 'dynamic_flow',
            dynamicEntry: async () => 'done',
          }),
        );

        const response = await client.get<{dotSrc: string}>(
          '/dev/apps/testApp/build_graph_image',
        );

        expect(response.status).toBe(200);
        expect(response.data?.dotSrc).toContain('"dynamic_flow"');
      });

      it('returns 404 for an app that does not exist', async () => {
        await expect(
          client.get('/dev/apps/nope/build_graph_image'),
        ).rejects.toMatchObject({response: {status: 404}});
      });

      it('returns 404 for a node path that resolves to nothing', async () => {
        await expect(
          client.get('/dev/apps/testApp/build_graph_image?node=ghost'),
        ).rejects.toMatchObject({response: {status: 404}});
      });
    });
  });

  describe('A2A', () => {
    const A2A_TOKEN = 'test-a2a-token';
    let a2aServer: AdkApiServer | undefined;

    const startA2aServer = async (a2aAuthToken?: string) => {
      a2aServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        a2a: true,
        a2aAuthToken,
      });
      await a2aServer.start();
      return a2aServer.url;
    };

    beforeEach(() => {
      vi.stubEnv(A2A_AUTH_TOKEN_ENV_VAR, undefined);
      // The SDK logs the rejection thrown by the authenticator; keep it out of
      // the test output.
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
      await a2aServer?.stop();
      a2aServer = undefined;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it('should return 404 for A2A endpoints when disabled', async () => {
      try {
        await client.get(`/a2a/testApp/${AGENT_CARD_PATH}`);
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(404);
      }
    });

    // The agent card route is mounted without a user builder, so it stays
    // readable whether or not the rest of the surface is authenticated.
    it.each([undefined, A2A_TOKEN])(
      'should serve the agent card publicly (auth token: %s)',
      async (a2aAuthToken) => {
        const a2aClient = new HttpClient(await startA2aServer(a2aAuthToken));

        const response = await a2aClient.get<AgentCard>(
          `/a2a/testApp/${AGENT_CARD_PATH}`,
        );

        expect(response.status).toBe(200);
        expect(response.data?.name).toBe('testAgent');
        expect(response.data?.url).toBe(
          `${a2aServer!.url}/a2a/testApp/jsonrpc`,
        );
      },
    );

    it('should run the agent for a call carrying the configured token', async () => {
      const url = await startA2aServer(A2A_TOKEN);

      const response = await sendA2aMessage(url, `Bearer ${A2A_TOKEN}`);

      expect(response.status).toBe(200);
      expect(response.body.error).toBeUndefined();
      expect(response.body.result).toBeDefined();
    });

    it('should reject a call with a missing or wrong token', async () => {
      const url = await startA2aServer(A2A_TOKEN);

      for (const authorization of [undefined, 'Bearer wrong-token']) {
        const response = await sendA2aMessage(url, authorization);

        // The SDK picks the status; all that matters is that the agent was
        // not reached.
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.body.result).toBeUndefined();
        expect(response.body.error).toBeDefined();
      }
    });

    it(`should honour the ${A2A_AUTH_TOKEN_ENV_VAR} environment variable`, async () => {
      vi.stubEnv(A2A_AUTH_TOKEN_ENV_VAR, A2A_TOKEN);
      const url = await startA2aServer();

      expect((await sendA2aMessage(url)).status).toBeGreaterThanOrEqual(400);
      expect((await sendA2aMessage(url, `Bearer ${A2A_TOKEN}`)).status).toBe(
        200,
      );
    });

    it('should prefer the explicit token over the environment variable', async () => {
      vi.stubEnv(A2A_AUTH_TOKEN_ENV_VAR, 'env-token');
      const url = await startA2aServer(A2A_TOKEN);

      expect(
        (await sendA2aMessage(url, 'Bearer env-token')).status,
      ).toBeGreaterThanOrEqual(400);
      expect((await sendA2aMessage(url, `Bearer ${A2A_TOKEN}`)).status).toBe(
        200,
      );
    });

    it('should serve an unauthenticated surface when no token is configured', async () => {
      const url = await startA2aServer();

      const response = await sendA2aMessage(url);

      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
    });
  });

  describe('Reasoning Engine', () => {
    it('should return 200 OK on health endpoints when debug UI is disabled', async () => {
      const healthResponse = await client.get<string>('/health');
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.text).toBe('OK');

      const rootResponse = await client.get<string>('/');
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.text).toBe('OK');
    });

    it('should query the agent using reasoning_engine route with valid JSON', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const response = await client.post<{output: Event[]}>(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: {
              parts: [{text: 'Hello'}],
              role: 'user',
            },
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.data?.output).toBeDefined();
      expect(response.data?.output.length).toBe(3);
      expect(response.data?.output[0].content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('forwards customMetadata from the reasoning engine input to Runner.runAsync', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });

      const spy = vi.spyOn(Runner.prototype, 'runAsync');

      const response = await client.post<{output: Event[]}>(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: {
              parts: [{text: 'Hello'}],
              role: 'user',
            },
            customMetadata: {requestId: 'abc-123'},
          },
        },
      );

      expect(response.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].customMetadata).toEqual({
        requestId: 'abc-123',
      });

      spy.mockRestore();
    });

    it('should auto-create session if not exists on reasoning_engine query', async () => {
      const response = await client.post<{output: Event[]}>(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'newSessionId',
            newMessage: {
              parts: [{text: 'Hello'}],
              role: 'user',
            },
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.data?.output).toBeDefined();

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'newSessionId',
      });
      expect(session).toBeDefined();
    });

    it('should support raw body query and parse headers workaround', async () => {
      const url = `${server.url}/api/reasoning_engine`;
      const payload = {
        input: {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'rawSessionId',
          newMessage: {
            parts: [{text: 'Hello'}],
            role: 'user',
          },
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json,application/json',
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {output: Event[]};
      expect(data.output).toBeDefined();
      expect(data.output[0].content?.parts?.[0].text).toBe(
        "Hello user! I'm streaming you events now!",
      );
    });

    it('should return 400 if appName is missing', async () => {
      try {
        await client.post('/api/reasoning_engine', {
          input: {
            userId: 'testUser',
            sessionId: 'sessionId',
          },
        });
        expect.fail('Should fail with 400');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(400);
        expect((e as {message: string}).message).toContain(
          'appName is required',
        );
      }
    });

    it('should return 500 if execution fails', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      agentLoader.getAgentFile = () => Promise.reject(new Error('Load failed'));

      try {
        await client.post('/api/reasoning_engine', {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
          },
        });
        expect.fail('Should fail with 500');
      } catch (e: unknown) {
        expect((e as {response: {status: number}}).response.status).toBe(500);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });

    it('returns 400 when a raw request body is not valid JSON', async () => {
      const res = await fetch(`${server.url}/api/reasoning_engine`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json,application/json'},
        body: '{not valid json',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Request body is not valid JSON.',
      });
    });

    it('returns 413 when a raw request body is larger than the limit', async () => {
      const res = await fetch(`${server.url}/api/reasoning_engine`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json,application/json'},
        body: 'a'.repeat(50 * 1024 * 1024 + 1),
      });

      expect(res.status).toBe(413);
    });

    it.each([
      {name: 'already-parsed JSON body', contentType: 'application/json'},
      {
        name: 'raw request stream body',
        contentType: 'application/json,application/json',
      },
    ])(
      'does not log request headers or body for $name',
      async ({contentType}) => {
        const authSentinel = 'secret-bearer-token-sentinel';
        const cookieSentinel = 'secret-cookie-value-sentinel';
        const bodySentinel = 'secret-user-message-sentinel';
        const loggedMessages: string[] = [];
        const recordArgs = (...args: unknown[]) => {
          loggedMessages.push(args.map(String).join(' '));
        };
        const spies = [
          vi.spyOn(AdkLogger.prototype, 'debug').mockImplementation(recordArgs),
          vi.spyOn(AdkLogger.prototype, 'info').mockImplementation(recordArgs),
          vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(recordArgs),
          vi.spyOn(AdkLogger.prototype, 'error').mockImplementation(recordArgs),
          vi
            .spyOn(AdkLogger.prototype, 'log')
            .mockImplementation((_level, ...args) => {
              recordArgs(...args);
            }),
        ];

        try {
          const res = await fetch(`${server.url}/api/reasoning_engine`, {
            method: 'POST',
            headers: {
              'Content-Type': contentType,
              Authorization: `Bearer ${authSentinel}`,
              Cookie: `session=${cookieSentinel}`,
            },
            body: JSON.stringify({
              input: {
                appName: 'testApp',
                userId: 'testUser',
                sessionId: 'sentinelSession',
                newMessage: {
                  parts: [{text: bodySentinel}],
                  role: 'user',
                },
              },
            }),
          });

          expect(res.status).toBe(200);
          expect(loggedMessages).toContain('POST /api/reasoning_engine');
          const allLogs = loggedMessages.join('\n');
          expect(allLogs).not.toContain(authSentinel);
          expect(allLogs).not.toContain(cookieSentinel);
          expect(allLogs).not.toContain(bodySentinel);
        } finally {
          for (const spy of spies) {
            spy.mockRestore();
          }
        }
      },
    );
  });

  describe('Startup', () => {
    it('should throw an error if the port is already in use', async () => {
      const portString = server.url.split(':').pop();
      const port = portString ? parseInt(portString, 10) : 0;

      expect(port).toBeGreaterThan(0);

      const duplicateServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        port: port,
      });

      try {
        await expect(duplicateServer.start()).rejects.toThrow(
          `Port ${port} is already in use`,
        );
      } finally {
        await duplicateServer.stop();
      }
    });

    it('should default to listening on localhost', async () => {
      const defaultServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await defaultServer.start();
      try {
        const address = (
          defaultServer as unknown as {
            server: {address: () => {address: string}};
          }
        ).server.address();
        expect(address.address).toMatch(/127\.0\.0\.1|::1|localhost/);
      } finally {
        await defaultServer.stop();
      }
    });

    it('should listen on specified host', async () => {
      const specificServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        host: '127.0.0.1',
      });
      await specificServer.start();
      try {
        const address = (
          specificServer as unknown as {
            server: {address: () => {address: string}};
          }
        ).server.address();
        expect(address.address).toBe('127.0.0.1');
      } finally {
        await specificServer.stop();
      }
    });
  });

  describe('Agent Runtime telemetry', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    /** Starts a server, sends one request, and counts telemetry flushes. */
    async function countFlushesForOneRequest({
      agentEngineId,
      otelToCloud,
    }: {
      agentEngineId?: string;
      otelToCloud: boolean;
    }): Promise<number> {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', agentEngineId);
      const forceFlush = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(adk, 'getGcpProjectId').mockResolvedValue('test-project');
      vi.spyOn(adk, 'getGcpExporters').mockResolvedValue({
        spanProcessors: [{forceFlush} as unknown as SpanProcessor],
      });
      vi.spyOn(adk, 'getGcpResource').mockResolvedValue(emptyResource());
      vi.spyOn(adk, 'maybeSetOtelProviders').mockReturnValue(undefined);
      const telemetryServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        otelToCloud,
      });
      await telemetryServer.start();
      try {
        const response = await fetch(`${telemetryServer.url}/version`);
        expect(response.status).toBe(200);
      } finally {
        await telemetryServer.stop();
      }
      return forceFlush.mock.calls.length;
    }

    it('flushes telemetry on each request on Agent Runtime with cloud export', async () => {
      await expect(
        countFlushesForOneRequest({
          agentEngineId: 'agent-123',
          otelToCloud: true,
        }),
      ).resolves.toBe(1);
    });

    it('installs no request hooks off Agent Runtime', async () => {
      await expect(
        countFlushesForOneRequest({otelToCloud: true}),
      ).resolves.toBe(0);
    });

    it('installs no request hooks without cloud export', async () => {
      await expect(
        countFlushesForOneRequest({
          agentEngineId: 'agent-123',
          otelToCloud: false,
        }),
      ).resolves.toBe(0);
    });

    it('flushes telemetry when a /run_live WebSocket upgrade session ends', async () => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'agent-123');
      const forceFlush = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(adk, 'getGcpProjectId').mockResolvedValue('test-project');
      vi.spyOn(adk, 'getGcpExporters').mockResolvedValue({
        spanProcessors: [{forceFlush} as unknown as SpanProcessor],
      });
      vi.spyOn(adk, 'getGcpResource').mockResolvedValue(emptyResource());
      vi.spyOn(adk, 'maybeSetOtelProviders').mockReturnValue(undefined);
      const telemetryServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        otelToCloud: true,
      });
      await telemetryServer.start();
      try {
        const target = new URL(
          `${telemetryServer.url}/run_live?app_name=testApp&user_id=testUser&session_id=missing`,
        );
        await new Promise<void>((resolve, reject) => {
          const req = http.request({
            host: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key':
                Buffer.from('1234567890123456').toString('base64'),
              'Sec-WebSocket-Version': '13',
            },
          });
          req.on('upgrade', (_res, socket) => {
            socket.on('close', () => resolve());
            socket.resume();
          });
          req.on('error', reject);
          req.end();
        });
      } finally {
        await telemetryServer.stop();
      }
      expect(forceFlush).toHaveBeenCalledTimes(1);
    });

    it('answers a client WebSocket close frame only after telemetry is flushed', async () => {
      vi.stubEnv('GOOGLE_CLOUD_AGENT_ENGINE_ID', 'agent-123');
      const events: string[] = [];
      const forceFlush = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        events.push('flushed');
      });
      vi.spyOn(adk, 'getGcpProjectId').mockResolvedValue('test-project');
      vi.spyOn(adk, 'getGcpExporters').mockResolvedValue({
        spanProcessors: [{forceFlush} as unknown as SpanProcessor],
      });
      vi.spyOn(adk, 'getGcpResource').mockResolvedValue(emptyResource());
      vi.spyOn(adk, 'maybeSetOtelProviders').mockReturnValue(undefined);
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'liveCloseSessionId',
      });
      const telemetryServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        otelToCloud: true,
      });
      await telemetryServer.start();
      try {
        const target = new URL(
          `${telemetryServer.url}/run_live?app_name=testApp&user_id=testUser&session_id=liveCloseSessionId`,
        );
        await new Promise<void>((resolve, reject) => {
          const req = http.request({
            host: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Key':
                Buffer.from('1234567890123456').toString('base64'),
              'Sec-WebSocket-Version': '13',
            },
          });
          req.on('upgrade', (_res, socket, head) => {
            let buf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
            const checkForCloseFrame = () => {
              // Skip any text frames the server sends before its close frame.
              while (buf.length >= 2) {
                const opcode = buf[0] & 0x0f;
                let len = buf[1] & 0x7f;
                let offset = 2;
                if (len === 126) {
                  if (buf.length < 4) {
                    return;
                  }
                  len = buf.readUInt16BE(2);
                  offset = 4;
                }
                if (buf.length < offset + len) {
                  return;
                }
                buf = buf.subarray(offset + len);
                if (opcode === 0x08) {
                  events.push('closeFrame');
                  return;
                }
              }
            };
            socket.on('data', (chunk: Buffer) => {
              buf = Buffer.concat([buf, Buffer.from(chunk)]);
              checkForCloseFrame();
            });
            socket.on('close', () => resolve());
            socket.on('error', reject);
            checkForCloseFrame();

            // Send a masked client close frame with status code 1000.
            const payload = Buffer.from([0x03, 0xe8]);
            const mask = Buffer.from([1, 2, 3, 4]);
            const masked = Buffer.from(
              payload.map((byte, i) => byte ^ mask[i % 4]),
            );
            socket.write(
              Buffer.concat([
                Buffer.from([0x88, 0x80 | payload.length]),
                mask,
                masked,
              ]),
            );
          });
          req.on('error', reject);
          req.end();
        });
      } finally {
        await telemetryServer.stop();
      }
      expect(events).toEqual(['flushed', 'closeFrame']);
      expect(forceFlush).toHaveBeenCalledTimes(1);
    });
  });

  describe('Agent Engine trace context', () => {
    const AGENT_ENGINE_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
    const AGENT_ENGINE_SPAN_ID = 'b7ad6b7169203331';
    const AGENT_ENGINE_HEADERS = {
      'Google-Agent-Engine-Traceparent': `00-${AGENT_ENGINE_TRACE_ID}-${AGENT_ENGINE_SPAN_ID}-01`,
      'traceparent': '00-11111111111111111111111111111111-2222222222222222-01',
    };
    const INVALID_HEADERS = {
      'Google-Agent-Engine-Traceparent': 'not a traceparent',
      'traceparent': '00-11111111111111111111111111111111-2222222222222222-01',
    };
    const AGENT_ENGINE_SPAN_CONTEXT: SpanContext = {
      traceId: AGENT_ENGINE_TRACE_ID,
      spanId: AGENT_ENGINE_SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    };
    const NEW_MESSAGE = {parts: [{text: 'Hello'}], role: 'user'};
    const contextManager = new AsyncLocalStorageContextManager();

    beforeAll(() => {
      context.setGlobalContextManager(contextManager.enable());
    });

    afterAll(() => {
      context.disable();
      contextManager.disable();
    });

    beforeEach(async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
    });

    /** Records the span context active each time the runner starts a run. */
    function recordRunSpanContexts(
      method: 'runAsync' | 'runLive',
    ): Array<SpanContext | undefined> {
      const recorded: Array<SpanContext | undefined> = [];
      const record = () => {
        recorded.push(trace.getSpanContext(context.active()));
      };
      const {runAsync, runLive} = Runner.prototype;
      const spy =
        method === 'runAsync'
          ? vi.spyOn(Runner.prototype, 'runAsync').mockImplementation(function (
              this: Runner,
              params,
            ) {
              record();
              return runAsync.call(this, params);
            })
          : vi.spyOn(Runner.prototype, 'runLive').mockImplementation(function (
              this: Runner,
              params,
            ) {
              record();
              return runLive.call(this, params);
            });
      onTestFinished(() => {
        spy.mockRestore();
      });
      return recorded;
    }

    /** Opens a /run_live session and waits for the first server frame. */
    async function openLiveSession(
      headers: Record<string, string>,
    ): Promise<void> {
      const target = new URL(
        `${server.url}/run_live?app_name=testApp&user_id=testUser&session_id=sessionId&modalities=TEXT`,
      );
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            ...headers,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key':
              Buffer.from('1234567890123456').toString('base64'),
            'Sec-WebSocket-Version': '13',
          },
        });
        req.on('upgrade', (_res, socket) => {
          socket.on('data', () => {
            socket.destroy();
          });
          socket.on('close', () => {
            resolve();
          });
          socket.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
    }

    it.each(['/run', '/run_sse'])(
      'continues the Agent Engine trace on %s',
      async (route) => {
        const recorded = recordRunSpanContexts('runAsync');

        const response = await client.post(
          route,
          {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: NEW_MESSAGE,
          },
          AGENT_ENGINE_HEADERS,
        );

        expect(response.status).toBe(200);
        expect(recorded).toEqual([AGENT_ENGINE_SPAN_CONTEXT]);
      },
    );

    it('continues the Agent Engine trace on /api/reasoning_engine', async () => {
      const recorded = recordRunSpanContexts('runAsync');

      const response = await client.post(
        '/api/reasoning_engine',
        {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: NEW_MESSAGE,
          },
        },
        AGENT_ENGINE_HEADERS,
      );

      expect(response.status).toBe(200);
      expect(recorded).toEqual([AGENT_ENGINE_SPAN_CONTEXT]);
    });

    it('continues the Agent Engine trace on A2A', async () => {
      vi.stubEnv(A2A_AUTH_TOKEN_ENV_VAR, undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a2aServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        a2a: true,
      });
      await a2aServer.start();
      onTestFinished(async () => {
        await a2aServer.stop();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
      });
      const recorded = recordRunSpanContexts('runAsync');

      const response = await sendA2aMessage(
        a2aServer.url,
        undefined,
        AGENT_ENGINE_HEADERS,
      );

      expect(response.status).toBe(200);
      expect(recorded).toEqual([AGENT_ENGINE_SPAN_CONTEXT]);
    });

    it('continues the Agent Engine trace on /run_live', async () => {
      const recorded = recordRunSpanContexts('runLive');

      await openLiveSession(AGENT_ENGINE_HEADERS);

      expect(recorded).toEqual([AGENT_ENGINE_SPAN_CONTEXT]);
    });

    it.each([
      {
        route: '/run',
        body: {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessionId',
          newMessage: NEW_MESSAGE,
        },
      },
      {
        route: '/api/reasoning_engine',
        body: {
          input: {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'sessionId',
            newMessage: NEW_MESSAGE,
          },
        },
      },
    ])('ignores an invalid header on $route', async ({route, body}) => {
      const recorded = recordRunSpanContexts('runAsync');

      const response = await client.post(route, body, INVALID_HEADERS);

      expect(response.status).toBe(200);
      expect(recorded).toEqual([undefined]);
    });

    it('sets no parent without the headers', async () => {
      const recorded = recordRunSpanContexts('runAsync');

      const response = await client.post('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        newMessage: NEW_MESSAGE,
      });

      expect(response.status).toBe(200);
      expect(recorded).toEqual([undefined]);
    });
  });

  describe('Shutdown', () => {
    it('should resolve a second stop() and still free the port on the first', async () => {
      const shutdownServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await shutdownServer.start();

      const port = parseInt(shutdownServer.url.split(':').pop() ?? '0', 10);
      expect(port).toBeGreaterThan(0);

      await expect(shutdownServer.stop()).resolves.toBeUndefined();
      await expect(shutdownServer.stop()).resolves.toBeUndefined();

      // The no-op second stop() must not have cost the first one its close.
      const reboundServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        port,
      });
      try {
        await expect(reboundServer.start()).resolves.toBeUndefined();
      } finally {
        await reboundServer.stop();
      }
    });

    it('should resolve stop() on a server that never started', async () => {
      const unstartedServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });

      await expect(unstartedServer.stop()).resolves.toBeUndefined();
    });

    it('should resolve stop() after start() failed on a port in use', async () => {
      const port = parseInt(server.url.split(':').pop() ?? '0', 10);
      expect(port).toBeGreaterThan(0);

      const duplicateServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        port,
      });

      await expect(duplicateServer.start()).rejects.toThrow(
        `Port ${port} is already in use`,
      );
      await expect(duplicateServer.stop()).resolves.toBeUndefined();
    });

    it('should reject when close() reports an error', async () => {
      const failingServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      const closeError = new Error('close failed');
      // No real listener fails to close, so stand one in. Same private-field
      // shape the Startup tests above use to read `address()`.
      (
        failingServer as unknown as {
          server: {
            listening: boolean;
            close: (cb: (err?: Error) => void) => void;
          };
        }
      ).server = {
        listening: true,
        close: (cb) => cb(closeError),
      };

      await expect(failingServer.stop()).rejects.toThrow('close failed');
    });

    it('closes cached runners when stop() is called', async () => {
      const closeServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await closeServer.start();

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'cleanupSession',
      });

      const closeClient = new HttpClient(closeServer.url);
      await closeClient.post<Event[]>('/run', {
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'cleanupSession',
        newMessage: {
          parts: [{text: 'Hello'}],
          role: 'user',
        },
      });

      const closeSpy = vi.spyOn(Runner.prototype, 'close');
      try {
        await closeServer.stop();
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        closeSpy.mockRestore();
      }
    });
  });

  describe('Internal caches keyed by request input', () => {
    // `appName` / `eventId` arrive straight off the request path. On a plain
    // object literal, inherited names such as `toString` make `key in cache`
    // report a spurious hit and hand back a Function where a Runner or trace
    // record is expected.
    const INHERITED_KEYS = ['toString', 'constructor', 'hasOwnProperty'];

    it('builds a real Runner for an app named after an inherited key', async () => {
      const getRunner = (
        server as unknown as {
          getRunner: (agent: unknown, appName: string) => Promise<Runner>;
        }
      ).getRunner.bind(server);

      for (const appName of INHERITED_KEYS) {
        const runner = await getRunner(TEST_AGENT, appName);
        expect(runner).toBeInstanceOf(Runner);
        expect(runner.appName).toBe(appName);
      }
    });

    it('returns 404 for a trace id matching an inherited key', async () => {
      for (const eventId of INHERITED_KEYS) {
        const response = await fetch(`${server.url}/debug/trace/${eventId}`);
        expect(response.status).toBe(404);
      }
    });

    it('replaces the cached Runner when an app reloads with a new agent instance', async () => {
      const getRunner = (
        server as unknown as {
          getRunner: (agent: unknown, appName: string) => Promise<Runner>;
        }
      ).getRunner.bind(server);

      const firstRunner = await getRunner(TEST_AGENT, 'testApp');
      const sameRunner = await getRunner(TEST_AGENT, 'testApp');
      expect(sameRunner).toBe(firstRunner);

      const reloadedAgent = new LlmAgent({
        name: 'testAgentReloaded',
        description: 'reloaded agent',
      });
      const reloadedRunner = await getRunner(reloadedAgent, 'testApp');
      expect(reloadedRunner).not.toBe(firstRunner);
      expect(reloadedRunner.agent).toBe(reloadedAgent);
    });

    it('acquires and releases agentFile.retain() lease across /run requests, including failed runs', async () => {
      const originalGetAgentFile = agentLoader.getAgentFile;
      let activeLeases = 0;
      let maxConcurrentLeases = 0;
      let releaseCount = 0;
      let shouldThrow = false;

      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          retain() {
            activeLeases++;
            maxConcurrentLeases = Math.max(maxConcurrentLeases, activeLeases);
            return {
              async [Symbol.asyncDispose]() {
                activeLeases--;
                releaseCount++;
              },
            };
          },
          load: () =>
            Promise.resolve(
              new Workflow({
                name: 'lease_wf',
                edges: [
                  [
                    'START',
                    node(
                      async () => {
                        if (shouldThrow) {
                          throw new Error('run failed');
                        }
                        return 'ok';
                      },
                      {name: 'step'},
                    ),
                  ],
                ],
              }),
            ),
        })) as unknown as AgentLoader['getAgentFile'];

      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'leaseSession',
      });

      try {
        const okRes = await client.post('/run', {
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'leaseSession',
          newMessage: {role: 'user', parts: [{text: 'hi'}]},
        });
        expect(okRes.status).toBe(200);
        expect(maxConcurrentLeases).toBe(1);
        expect(activeLeases).toBe(0);
        expect(releaseCount).toBe(1);

        shouldThrow = true;
        await expect(
          client.post('/run', {
            appName: 'testApp',
            userId: 'testUser',
            sessionId: 'leaseSession',
            newMessage: {role: 'user', parts: [{text: 'fail'}]},
          }),
        ).rejects.toThrow();
        expect(activeLeases).toBe(0);
        expect(releaseCount).toBe(2);
      } finally {
        agentLoader.getAgentFile = originalGetAgentFile;
      }
    });
  });

  describe('Eval sets, artifact versions, and live WebSocket endpoints', () => {
    it('filters out eval sessions starting with EVAL_SESSION_ID_PREFIX in list_sessions', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'normal_session',
      });
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: `${EVAL_SESSION_ID_PREFIX}hidden_session`,
      });

      const response = await client.get<{sessions: Session[]}>(
        '/apps/testApp/users/testUser/sessions',
      );

      expect(response.status).toBe(200);
      expect(response.data?.sessions.map((s) => s.id)).toEqual([
        'normal_session',
      ]);
    });

    it('supports optional ?version query param on load_artifact endpoint', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'doc.txt',
        artifact: {text: 'v0-text'},
      });
      await artifactService.saveArtifact({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'sessionId',
        filename: 'doc.txt',
        artifact: {text: 'v1-text'},
      });

      const v0 = await client.get<{text: string}>(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/doc.txt?version=0',
      );
      const latest = await client.get<{text: string}>(
        '/apps/testApp/users/testUser/sessions/sessionId/artifacts/doc.txt',
      );

      expect(v0.data).toEqual({text: 'v0-text'});
      expect(latest.data).toEqual({text: 'v1-text'});
    });

    it('streams live events over the /run_live WebSocket endpoint (test_websocket_endpoint)', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'testUser',
        sessionId: 'liveSessionId',
      });

      const target = new URL(
        `${server.url}/run_live?app_name=testApp&user_id=testUser&session_id=liveSessionId&modalities=TEXT`,
      );

      const receivedEvent = await new Promise<Event>((resolve, reject) => {
        const req = http.request({
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key':
              Buffer.from('1234567890123456').toString('base64'),
            'Sec-WebSocket-Version': '13',
          },
        });

        req.on('upgrade', (_res, socket, head) => {
          let buf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);

          const tryParseFrame = () => {
            if (buf.length < 2) {
              return;
            }
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
              if (buf.length < 4) {
                return;
              }
              len = buf.readUInt16BE(2);
              offset = 4;
            }
            if (buf.length < offset + len) {
              return;
            }
            const payload = buf.subarray(offset, offset + len);
            buf = buf.subarray(offset + len);
            if (opcode === 0x01) {
              socket.destroy();
              resolve(JSON.parse(payload.toString('utf-8')) as Event);
            }
          };

          socket.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, Buffer.from(chunk)]);
            tryParseFrame();
          });
          socket.on('error', reject);

          // Send a masked client text frame with a LiveRequest message.
          const msg = Buffer.from(
            JSON.stringify({
              content: {role: 'user', parts: [{text: 'Hello live'}]},
            }),
            'utf-8',
          );
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = Buffer.alloc(msg.length);
          for (let i = 0; i < msg.length; i++) {
            masked[i] = msg[i] ^ mask[i % 4];
          }
          socket.write(
            Buffer.concat([
              Buffer.from([0x81, 0x80 | msg.length]),
              mask,
              masked,
            ]),
          );
          tryParseFrame();
        });

        req.on('error', reject);
        req.end();
      });

      expect(receivedEvent.author).toBe('testAgent');
      expect(receivedEvent.content?.parts?.[0].text).toBe('test live content');
    });

    it('creates, lists, populates, and runs eval sets through the eval_sets endpoints', async () => {
      const tempAgentsDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'adk-eval-api-test-'),
      );
      const evalServer = new AdkApiServer({
        agentsDir: tempAgentsDir,
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await evalServer.start();
      const evalClient = new HttpClient(evalServer.url);

      try {
        // 1. Create an eval set
        const createRes = await evalClient.post(
          '/apps/testApp/eval_sets/set_one',
          {},
        );
        expect(createRes.status).toBe(200);

        // 2. Reject invalid eval set ID
        await expect(
          evalClient.post('/apps/testApp/eval_sets/invalid-id!', {}),
        ).rejects.toMatchObject({response: {status: 400}});

        // 3. List eval sets
        const listSetsRes = await evalClient.get<string[]>(
          '/apps/testApp/eval_sets',
        );
        expect(listSetsRes.data).toEqual(['set_one']);

        // 4. Create a session and run a turn so it has events
        const sess = await sessionService.createSession({
          appName: 'testApp',
          userId: 'testUser',
          sessionId: 'sessForEval',
        });
        await sessionService.appendEvent({
          session: sess,
          event: createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'Hi'}]},
          }),
        });
        await sessionService.appendEvent({
          session: sess,
          event: createEvent({
            author: 'testAgent',
            content: {role: 'model', parts: [{text: 'Event 2'}]},
          }),
        });

        // 5. Add the session to the eval set
        const addRes = await evalClient.post(
          '/apps/testApp/eval_sets/set_one/add_session',
          {
            evalId: 'case_1',
            sessionId: 'sessForEval',
            userId: 'testUser',
          },
        );
        expect(addRes.status).toBe(200);

        // 6. List evals in the eval set
        const listEvalsRes = await evalClient.get<string[]>(
          '/apps/testApp/eval_sets/set_one/evals',
        );
        expect(listEvalsRes.data).toEqual(['case_1']);

        // 6a. Get the eval case by ID
        const getCaseRes = await evalClient.get<{
          evalId: string;
          conversation: Array<{
            userContent: {parts: Array<{text?: string}>};
            finalResponse?: {parts: Array<{text?: string}>};
          }>;
        }>('/apps/testApp/eval_sets/set_one/evals/case_1');
        expect(getCaseRes.status).toBe(200);
        expect(getCaseRes.data?.evalId).toBe('case_1');
        expect(getCaseRes.data?.conversation).toHaveLength(1);
        expect(
          getCaseRes.data?.conversation[0].userContent.parts[0]?.text,
        ).toBe('Hi');
        expect(
          getCaseRes.data?.conversation[0].finalResponse?.parts[0]?.text,
        ).toBe('Event 2');

        // 6b. Return 404 when getting a missing eval case or missing eval set
        await expect(
          evalClient.get('/apps/testApp/eval_sets/set_one/evals/missing_case'),
        ).rejects.toMatchObject({response: {status: 404}});
        await expect(
          evalClient.get('/apps/testApp/eval_sets/missing_set/evals/case_1'),
        ).rejects.toMatchObject({response: {status: 404}});

        // 6c. Reject PUT when body evalId does not match route evalCaseId
        await expect(
          evalClient.put('/apps/testApp/eval_sets/set_one/evals/case_1', {
            evalId: 'different_id',
            conversation: getCaseRes.data?.conversation ?? [],
          }),
        ).rejects.toMatchObject({
          response: {
            status: 400,
            data: {
              error: expect.stringMatching(
                /Eval id in EvalCase should match the eval id in the API route/,
              ),
            },
          },
        });

        // 6d. Update the eval case (with matching evalId and with empty evalId)
        const putResMatching = await evalClient.put(
          '/apps/testApp/eval_sets/set_one/evals/case_1',
          {
            evalId: 'case_1',
            conversation: getCaseRes.data?.conversation ?? [],
            creationTimestamp: 999,
          },
        );
        expect(putResMatching.status).toBe(200);

        const putResEmptyId = await evalClient.put(
          '/apps/testApp/eval_sets/set_one/evals/case_1',
          {
            evalId: '',
            conversation: getCaseRes.data?.conversation ?? [],
            creationTimestamp: 1000,
          },
        );
        expect(putResEmptyId.status).toBe(200);

        const updatedCaseRes = await evalClient.get<{
          evalId: string;
          creationTimestamp: number;
        }>('/apps/testApp/eval_sets/set_one/evals/case_1');
        expect(updatedCaseRes.data?.evalId).toBe('case_1');
        expect(updatedCaseRes.data?.creationTimestamp).toBe(1000);

        // 6e. Return 404 when updating a missing eval case
        await expect(
          evalClient.put(
            '/apps/testApp/eval_sets/set_one/evals/non_existent_case',
            {
              evalId: 'non_existent_case',
              conversation: [],
            },
          ),
        ).rejects.toMatchObject({response: {status: 404}});

        // 7. Run the eval set
        const runEvalRes = await evalClient.post<
          Array<Record<string, unknown>>
        >('/apps/testApp/eval_sets/set_one/run_eval', {
          evalIds: ['case_1'],
          evalMetrics: [
            {metric_name: 'tool_trajectory_avg_score', threshold: 1.0},
            {metric_name: 'response_match_score', threshold: 0.8},
          ],
        });
        expect(runEvalRes.status).toBe(200);
        expect(runEvalRes.data).toHaveLength(1);
        expect(runEvalRes.data?.[0].evalId).toBe('case_1');
        expect(runEvalRes.data?.[0].evalSetId).toBe('set_one');
        expect(runEvalRes.data?.[0].finalEvalStatus).toBe(EvalStatus.PASSED);
        expect(runEvalRes.data?.[0].sessionDetails).toBeDefined();
        expect(runEvalRes.data?.[0]).not.toHaveProperty('eval_id');
        expect(runEvalRes.data?.[0]).not.toHaveProperty('final_eval_status');
        expect(runEvalRes.data?.[0]).not.toHaveProperty('session_details');

        // 8. List persisted eval results
        const listResultsRes = await evalClient.get<string[]>(
          '/apps/testApp/eval_results',
        );
        expect(listResultsRes.status).toBe(200);
        expect(listResultsRes.data).toHaveLength(1);

        // 9. Get persisted eval result by ID
        const resultId = listResultsRes.data![0];
        const getResultRes = await evalClient.get<{
          evalSetResultId: string;
          evalSetId: string;
          evalCaseResults: Array<Record<string, unknown>>;
        }>(`/apps/testApp/eval_results/${resultId}`);
        expect(getResultRes.status).toBe(200);
        expect(getResultRes.data?.evalSetId).toBe('set_one');
        expect(getResultRes.data?.evalCaseResults).toHaveLength(1);
        expect(getResultRes.data?.evalCaseResults[0].evalId).toBe('case_1');
        expect(getResultRes.data?.evalCaseResults[0].evalSetId).toBe('set_one');
        expect(getResultRes.data?.evalCaseResults[0].finalEvalStatus).toBe(
          EvalStatus.PASSED,
        );
        expect(
          getResultRes.data?.evalCaseResults[0].overallEvalMetricResults,
        ).toHaveLength(2);
        expect(
          getResultRes.data?.evalCaseResults[0].evalMetricResultPerInvocation,
        ).toHaveLength(1);
        expect(
          getResultRes.data?.evalCaseResults[0].sessionDetails,
        ).toBeDefined();
        expect(getResultRes.data?.evalCaseResults[0]).not.toHaveProperty(
          'eval_id',
        );
        expect(getResultRes.data?.evalCaseResults[0]).not.toHaveProperty(
          'final_eval_status',
        );
        expect(getResultRes.data?.evalCaseResults[0]).not.toHaveProperty(
          'session_details',
        );

        // 10. Return 404 for missing or traversal eval result ID
        await expect(
          evalClient.get('/apps/testApp/eval_results/non_existent_result'),
        ).rejects.toMatchObject({response: {status: 404}});
        await expect(
          evalClient.get('/apps/testApp/eval_results/..%2Fsecret'),
        ).rejects.toMatchObject({
          response: {
            status: 404,
            data: {error: expect.stringMatching(/path separators/)},
          },
        });

        // 11. Return 500 when stored eval result JSON is corrupt
        const historyDir = path.join(
          tempAgentsDir,
          'testApp',
          '.adk',
          'eval_history',
        );
        fs.writeFileSync(
          path.join(historyDir, 'corrupt_result.evalset_result.json'),
          '{not valid json',
          'utf-8',
        );
        await expect(
          evalClient.get('/apps/testApp/eval_results/corrupt_result'),
        ).rejects.toMatchObject({response: {status: 500}});

        // 12. Delete the eval case and verify it is removed
        const deleteCaseRes = await evalClient.delete(
          '/apps/testApp/eval_sets/set_one/evals/case_1',
        );
        expect(deleteCaseRes.status).toBe(200);
        await expect(
          evalClient.get('/apps/testApp/eval_sets/set_one/evals/case_1'),
        ).rejects.toMatchObject({response: {status: 404}});

        // 13. Return 404 when deleting an already-deleted or missing eval case
        await expect(
          evalClient.delete('/apps/testApp/eval_sets/set_one/evals/case_1'),
        ).rejects.toMatchObject({response: {status: 404}});
      } finally {
        await evalServer.stop();
        fs.rmSync(tempAgentsDir, {recursive: true, force: true});
      }
    });

    it('validates eval set requests and serves them under the /dev prefix', async () => {
      const tempAgentsDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'adk-eval-api-validation-test-'),
      );
      const evalServer = new AdkApiServer({
        agentsDir: tempAgentsDir,
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await evalServer.start();
      const evalClient = new HttpClient(evalServer.url);

      try {
        // Create through the /dev prefix that the web UI uses.
        const createRes = await evalClient.post(
          '/dev/apps/testApp/eval_sets/dev_set',
          {},
        );
        expect(createRes.status).toBe(200);

        // Reject a second create for the same eval set.
        await expect(
          evalClient.post('/apps/testApp/eval_sets/dev_set', {}),
        ).rejects.toMatchObject({
          response: {
            status: 400,
            data: {
              error: 'EvalSet dev_set already exists for app testApp.',
            },
          },
        });

        const listRes = await evalClient.get<string[]>(
          '/dev/apps/testApp/eval_sets',
        );
        expect(listRes.data).toEqual(['dev_set']);

        const evalSetsManager = new LocalEvalSetsManager(tempAgentsDir);
        evalSetsManager.addEvalCase('testApp', 'dev_set', {
          evalId: 'case_1',
          conversation: [],
        });

        const listEvalsRes = await evalClient.get<string[]>(
          '/dev/apps/testApp/eval_sets/dev_set/evals',
        );
        expect(listEvalsRes.data).toEqual(['case_1']);

        const getCaseRes = await evalClient.get<{evalId: string}>(
          '/dev/apps/testApp/eval_sets/dev_set/evals/case_1',
        );
        expect(getCaseRes.data?.evalId).toBe('case_1');

        // Reject a PUT body that is an array.
        await expect(
          evalClient.put('/dev/apps/testApp/eval_sets/dev_set/evals/case_1', [
            {conversation: []},
          ]),
        ).rejects.toMatchObject({
          response: {
            status: 400,
            data: {error: 'Invalid EvalCase: expected a JSON object.'},
          },
        });

        // Reject a PUT body whose evalId is not a string.
        await expect(
          evalClient.put('/apps/testApp/eval_sets/dev_set/evals/case_1', {
            evalId: 123,
            conversation: [],
          }),
        ).rejects.toMatchObject({
          response: {
            status: 400,
            data: {error: 'Invalid EvalCase: evalId must be a string.'},
          },
        });

        const deleteRes = await evalClient.delete(
          '/dev/apps/testApp/eval_sets/dev_set/evals/case_1',
        );
        expect(deleteRes.status).toBe(200);
      } finally {
        await evalServer.stop();
        fs.rmSync(tempAgentsDir, {recursive: true, force: true});
      }
    });

    it('does not load the .env file of an app that the loader does not know', async () => {
      const tempAgentsDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'adk-unknown-app-env-test-'),
      );
      const envKey = 'ADK_UNKNOWN_APP_ENV_SENTINEL';
      fs.mkdirSync(path.join(tempAgentsDir, 'ghostApp'));
      fs.writeFileSync(
        path.join(tempAgentsDir, 'ghostApp', '.env'),
        `${envKey}=loaded\n`,
      );
      const rejectingLoader = {
        listAgents: () => Promise.resolve([]),
        getAgentFile: (name: string) =>
          Promise.reject(new Error(`Agent '${name}' not found`)),
      } as unknown as AgentLoader;
      const envServer = new AdkApiServer({
        agentsDir: tempAgentsDir,
        agentLoader: rejectingLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await envServer.start();
      const envClient = new HttpClient(envServer.url);

      try {
        await sessionService.createSession({
          appName: 'ghostApp',
          userId: 'testUser',
          sessionId: 'ghostSession',
        });

        await expect(
          envClient.post('/run', {
            appName: 'ghostApp',
            userId: 'testUser',
            sessionId: 'ghostSession',
            newMessage: {role: 'user', parts: [{text: 'Hello'}]},
          }),
        ).rejects.toMatchObject({response: {status: 500}});
        expect(process.env[envKey]).toBeUndefined();
      } finally {
        delete process.env[envKey];
        await envServer.stop();
        fs.rmSync(tempAgentsDir, {recursive: true, force: true});
      }
    });

    it('reports a thrown non-Error value as readable text when listing eval results fails', async () => {
      const listSpy = vi
        .spyOn(LocalEvalSetResultsManager.prototype, 'listEvalSetResults')
        .mockImplementation(() => {
          throw {code: 'EIO'};
        });
      const evalServer = new AdkApiServer({
        agentsDir: os.tmpdir(),
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
      });
      await evalServer.start();
      const evalClient = new HttpClient(evalServer.url);

      try {
        await expect(
          evalClient.get('/apps/testApp/eval_results'),
        ).rejects.toMatchObject({
          response: {
            status: 500,
            data: {error: 'Failed to list eval results: {"code":"EIO"}'},
          },
        });
      } finally {
        listSpy.mockRestore();
        await evalServer.stop();
      }
    });
  });
});

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Sends a request with the path exactly as given. `fetch` normalizes `..` and
 * `%2E%2E` path segments on the client, so traversal paths need this helper.
 */
function sendRawRequest(
  baseUrl: string,
  {method, rawPath, body}: {method: string; rawPath: string; body?: unknown},
): Promise<RawResponse> {
  const target = new URL(baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: rawPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({status: res.statusCode ?? 0, body: text}));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Opens a `/run_live` WebSocket and resolves with the close code that the
 * server sends.
 */
function getRunLiveCloseCode(baseUrl: string, query: string): Promise<number> {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: `/run_live?${query}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('1234567890123456').toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      let buf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      const tryParseClose = () => {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          const len = buf[1] & 0x7f;
          if (buf.length < 2 + len) {
            return;
          }
          const payload = buf.subarray(2, 2 + len);
          buf = buf.subarray(2 + len);
          if (opcode === 0x08) {
            socket.destroy();
            resolve(payload.readUInt16BE(0));
            return;
          }
        }
      };
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, Buffer.from(chunk)]);
        tryParseClose();
      });
      socket.on('end', () => reject(new Error('Socket ended without close.')));
      socket.on('error', reject);
      tryParseClose();
    });
    req.on('error', reject);
    req.end();
  });
}

describe('AdkApiServer path validation', () => {
  const AGENT_SECRET_KEY = 'ADK_TEST_AGENT_SECRET';
  const OUTSIDE_SECRET_KEY = 'ADK_TEST_OUTSIDE_SECRET';

  let rootDir: string;
  let agentsDir: string;
  let sessionService: BaseSessionService;
  let server: AdkApiServer;

  const newMessage = {role: 'user', parts: [{text: 'Hello'}]};

  function createLoader(): AgentLoader {
    return {
      listAgents: () => Promise.resolve(['testApp']),
      getAgentFile: (appName: string) => {
        if (appName !== 'testApp') {
          return Promise.reject(new Error(`Agent '${appName}' not found.`));
        }
        return Promise.resolve({
          retain: () => ({
            async [Symbol.asyncDispose](): Promise<void> {
              return;
            },
          }),
          load() {
            return Promise.resolve(TEST_AGENT);
          },
        });
      },
    } as unknown as AgentLoader;
  }

  async function startServer(serverAgentsDir: string): Promise<void> {
    server = new AdkApiServer({
      agentsDir: serverAgentsDir,
      agentLoader: createLoader(),
      sessionService,
      memoryService: new InMemoryMemoryService(),
      artifactService: new InMemoryArtifactService(),
    });
    await server.start();
  }

  beforeEach(async () => {
    delete process.env[AGENT_SECRET_KEY];
    delete process.env[OUTSIDE_SECRET_KEY];
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-path-validation-'));
    agentsDir = path.join(rootDir, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'testApp'), {recursive: true});
    fs.writeFileSync(
      path.join(agentsDir, 'testApp', '.env'),
      `${AGENT_SECRET_KEY}=agent\n`,
    );
    fs.writeFileSync(
      path.join(rootDir, '.env'),
      `${OUTSIDE_SECRET_KEY}=root\n`,
    );
    fs.mkdirSync(path.join(rootDir, 'outside_secret'));
    fs.writeFileSync(
      path.join(rootDir, 'outside_secret', '.env'),
      `${OUTSIDE_SECRET_KEY}=outside\n`,
    );
    fs.mkdirSync(path.join(rootDir, 'outside'));
    sessionService = new InMemorySessionService();
    await startServer(agentsDir);
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(rootDir, {recursive: true, force: true});
    delete process.env[AGENT_SECRET_KEY];
    delete process.env[OUTSIDE_SECRET_KEY];
  });

  describe('eval set routes', () => {
    const invalidAppNames = ['..%2Foutside', '..', 'foo%5Cbar'];
    const invalidEvalSetIds = [
      '..%2Foutside',
      '..',
      'invalid-id!',
      'foo%5Cbar',
    ];
    const routes: Array<{
      name: string;
      method: string;
      buildPath: (appName: string, evalSetId: string) => string;
      body?: unknown;
    }> = [
      {
        name: 'POST eval_sets/:evalSetId',
        method: 'POST',
        buildPath: (a, s) => `/apps/${a}/eval_sets/${s}`,
        body: {},
      },
      {
        name: 'POST add_session',
        method: 'POST',
        buildPath: (a, s) => `/apps/${a}/eval_sets/${s}/add_session`,
        body: {evalId: 'case_1', sessionId: 'session_1', userId: 'user_1'},
      },
      {
        name: 'GET evals',
        method: 'GET',
        buildPath: (a, s) => `/apps/${a}/eval_sets/${s}/evals`,
      },
      {
        name: 'POST run_eval',
        method: 'POST',
        buildPath: (a, s) => `/apps/${a}/eval_sets/${s}/run_eval`,
        body: {},
      },
    ];

    describe.each(routes)('$name', ({method, buildPath, body}) => {
      it.each(invalidAppNames)(
        'returns 400 for appName %s',
        async (appName) => {
          const response = await sendRawRequest(server.url, {
            method,
            rawPath: buildPath(appName, 'set_one'),
            body,
          });

          expect(response.status).toBe(400);
          expect(JSON.parse(response.body).error).toMatch(/appName/);
        },
      );

      it.each(invalidEvalSetIds)(
        'returns 400 for evalSetId %s',
        async (evalSetId) => {
          const response = await sendRawRequest(server.url, {
            method,
            rawPath: buildPath('testApp', evalSetId),
            body,
          });

          expect(response.status).toBe(400);
          expect(JSON.parse(response.body).error).toMatch(
            /evalSetId|eval set ID/,
          );
        },
      );
    });

    it.each(invalidAppNames)(
      'returns 400 from GET eval_sets for appName %s',
      async (appName) => {
        const response = await sendRawRequest(server.url, {
          method: 'GET',
          rawPath: `/apps/${appName}/eval_sets`,
        });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error).toMatch(/appName/);
      },
    );

    it('does not create an eval set outside agentsDir', async () => {
      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/apps/..%2Foutside/eval_sets/set_one',
        body: {},
      });

      expect(response.status).toBe(400);
      expect(fs.readdirSync(path.join(rootDir, 'outside'))).toEqual([]);
      expect(fs.existsSync(path.join(rootDir, 'set_one.evalset.json'))).toBe(
        false,
      );
    });

    it('does not list eval sets outside agentsDir', async () => {
      fs.writeFileSync(
        path.join(rootDir, 'outside', 'planted.evalset.json'),
        '[]',
      );

      const response = await sendRawRequest(server.url, {
        method: 'GET',
        rawPath: '/apps/..%2Foutside/eval_sets',
      });

      expect(response.status).toBe(400);
      expect(response.body).not.toContain('planted');
    });
  });

  describe('.env loading', () => {
    it.each([
      ['a traversal appName', {appName: '../outside_secret'}],
      ['an empty appName', {appName: ''}],
      ['a missing appName', {}],
    ])(
      'POST /run returns 400 for %s and loads no .env',
      async (_label, fields) => {
        await sessionService.createSession({
          appName: '../outside_secret',
          userId: 'user_1',
          sessionId: 'session_1',
        });

        const response = await sendRawRequest(server.url, {
          method: 'POST',
          rawPath: '/run',
          body: {
            ...fields,
            userId: 'user_1',
            sessionId: 'session_1',
            newMessage,
          },
        });

        expect(response.status).toBe(400);
        expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
      },
    );

    it.each([
      ['a traversal appName', {appName: '../outside_secret'}],
      ['an empty appName', {appName: ''}],
      ['a missing appName', {}],
    ])(
      'POST /run_sse returns 400 for %s and loads no .env',
      async (_label, fields) => {
        await sessionService.createSession({
          appName: '../outside_secret',
          userId: 'user_1',
          sessionId: 'session_1',
        });

        const response = await sendRawRequest(server.url, {
          method: 'POST',
          rawPath: '/run_sse',
          body: {
            ...fields,
            userId: 'user_1',
            sessionId: 'session_1',
            newMessage,
          },
        });

        expect(response.status).toBe(400);
        expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
      },
    );

    it('POST /run returns 500 for an unknown appName and loads no .env', async () => {
      await sessionService.createSession({
        appName: 'ghost',
        userId: 'user_1',
        sessionId: 'session_1',
      });

      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/run',
        body: {
          appName: 'ghost',
          userId: 'user_1',
          sessionId: 'session_1',
          newMessage,
        },
      });

      expect(response.status).toBe(500);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('POST /api/reasoning_engine fails for a traversal appName and loads no .env', async () => {
      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/api/reasoning_engine',
        body: {
          input: {
            appName: '../outside_secret',
            userId: 'user_1',
            sessionId: 'session_1',
            newMessage,
          },
        },
      });

      expect([400, 500]).toContain(response.status);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('/run_live closes with 1008 for a traversal appName and loads no .env', async () => {
      await sessionService.createSession({
        appName: '../outside_secret',
        userId: 'user_1',
        sessionId: 'session_1',
      });

      const code = await getRunLiveCloseCode(
        server.url,
        'app_name=../outside_secret&user_id=user_1&session_id=session_1',
      );

      expect(code).toBe(1008);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('/run_live closes with 1011 for an unknown appName and loads no .env', async () => {
      await sessionService.createSession({
        appName: 'ghost',
        userId: 'user_1',
        sessionId: 'session_1',
      });

      const code = await getRunLiveCloseCode(
        server.url,
        'app_name=ghost&user_id=user_1&session_id=session_1',
      );

      expect(code).toBe(1011);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('run_eval returns 400 for a traversal appName and loads no .env', async () => {
      fs.writeFileSync(
        path.join(rootDir, 'outside_secret', 'set_one.evalset.json'),
        '[]',
      );

      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/apps/..%2Foutside_secret/eval_sets/set_one/run_eval',
        body: {},
      });

      expect(response.status).toBe(400);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('run_eval returns 500 for an unknown appName and loads no .env', async () => {
      fs.mkdirSync(path.join(agentsDir, 'ghost'));
      fs.writeFileSync(
        path.join(agentsDir, 'ghost', 'set_one.evalset.json'),
        '[]',
      );

      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/apps/ghost/eval_sets/set_one/run_eval',
        body: {},
      });

      expect(response.status).toBe(500);
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('POST /run loads the .env of a registered agent', async () => {
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'user_1',
        sessionId: 'session_1',
      });

      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/run',
        body: {
          appName: 'testApp',
          userId: 'user_1',
          sessionId: 'session_1',
          newMessage,
        },
      });

      expect(response.status).toBe(200);
      expect(process.env[AGENT_SECRET_KEY]).toBe('agent');
      expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
    });

    it('POST /run loads the .env next to a single-file agentsDir', async () => {
      await server.stop();
      const agentFilePath = path.join(agentsDir, 'testApp', 'agent.ts');
      fs.writeFileSync(agentFilePath, '');
      await startServer(agentFilePath);
      await sessionService.createSession({
        appName: 'testApp',
        userId: 'user_1',
        sessionId: 'session_1',
      });

      const response = await sendRawRequest(server.url, {
        method: 'POST',
        rawPath: '/run',
        body: {
          appName: 'testApp',
          userId: 'user_1',
          sessionId: 'session_1',
          newMessage,
        },
      });

      expect(response.status).toBe(200);
      expect(process.env[AGENT_SECRET_KEY]).toBe('agent');
    });

    describe('with a real AgentLoader', () => {
      const prototypeNames = [
        'constructor',
        'toString',
        'hasOwnProperty',
        'valueOf',
      ];
      let realLoader: AgentLoader;

      beforeEach(async () => {
        await server.stop();
        realLoader = new AgentLoader(agentsDir);
        server = new AdkApiServer({
          agentsDir,
          agentLoader: realLoader,
          sessionService,
          memoryService: new InMemoryMemoryService(),
          artifactService: new InMemoryArtifactService(),
        });
        await server.start();
      });

      afterEach(async () => {
        await realLoader.disposeAll();
      });

      it.each(prototypeNames)(
        'POST /run returns 500 for appName %s and loads no .env',
        async (appName) => {
          await sessionService.createSession({
            appName,
            userId: 'user_1',
            sessionId: 'session_1',
          });

          const response = await sendRawRequest(server.url, {
            method: 'POST',
            rawPath: '/run',
            body: {
              appName,
              userId: 'user_1',
              sessionId: 'session_1',
              newMessage,
            },
          });

          expect(response.status).toBe(500);
          expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
        },
      );

      it.each(prototypeNames)(
        '/run_live closes with 1011 for appName %s and loads no .env',
        async (appName) => {
          await sessionService.createSession({
            appName,
            userId: 'user_1',
            sessionId: 'session_1',
          });

          const code = await getRunLiveCloseCode(
            server.url,
            `app_name=${appName}&user_id=user_1&session_id=session_1`,
          );

          expect(code).toBe(1011);
          expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
        },
      );

      it.each(prototypeNames)(
        'run_eval returns 500 for appName %s and loads no .env',
        async (appName) => {
          fs.mkdirSync(path.join(agentsDir, appName));
          fs.writeFileSync(
            path.join(agentsDir, appName, 'set_one.evalset.json'),
            '[]',
          );

          const response = await sendRawRequest(server.url, {
            method: 'POST',
            rawPath: `/apps/${appName}/eval_sets/set_one/run_eval`,
            body: {},
          });

          expect(response.status).toBe(500);
          expect(process.env[OUTSIDE_SECRET_KEY]).toBeUndefined();
        },
      );
    });
  });
});
