/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  node,
  Runner,
  Session,
  Workflow,
} from '@google/adk';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import * as http from 'node:http';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  A2A_AUTH_TOKEN_ENV_VAR,
  AdkApiServer,
} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {version} from '../../src/version.js';

interface JsonRpcResponse {
  result?: unknown;
  error?: {code: number; message: string};
}

/**
 * Sends a genuine A2A `message/send` JSON-RPC call, optionally with an
 * `Authorization` header, and reports the raw HTTP status so authentication
 * failures can be told apart from agent responses.
 */
async function sendA2aMessage(
  baseUrl: string,
  authorization?: string,
): Promise<{status: number; body: JsonRpcResponse}> {
  const response = await fetch(`${baseUrl}/a2a/testApp/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? {Authorization: authorization} : {}),
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

  post<T>(url: string, body?: unknown) {
    return this.request<T>(url, {method: 'POST', body});
  }

  put<T>(url: string, body?: unknown) {
    return this.request<T>(url, {method: 'PUT', body});
  }

  delete<T>(url: string) {
    return this.request<T>(url, {method: 'DELETE'});
  }

  private async request<T = unknown>(
    url: string,
    {method, body}: {method: string; body?: unknown},
  ): Promise<{status: number; data?: T; text?: string}> {
    const options = {
      method,
      headers: body ? {'Content-Type': 'application/json'} : undefined,
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
    it('should redirect to dev-ui when enabled', async () => {
      const debugServer = new AdkApiServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        serveDebugUI: true,
      });
      await debugServer.start();
      const debugClient = new HttpClient(debugServer.url);

      const response = await debugClient.get('/');
      expect(response.status).toBe(302);
      await debugServer.stop();
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
    function loadInstead(agent: unknown) {
      agentLoader.getAgentFile = (() =>
        Promise.resolve({
          load: () => Promise.resolve(agent),
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
  });
});
