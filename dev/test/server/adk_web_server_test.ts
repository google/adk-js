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
  Session,
} from '@google/adk';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import type {Application, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';

import {AdkWebServer} from '../../src/server/adk_web_server';
import {AgentLoader} from '../../src/utils/agent_loader';

/**
 * Simple http client for testing the AdkWebServer. No addtional npm
 * dependencies are required. It uses ExpressJS app, mocks the request/response
 * objects and returns the server response.
 */
class MockHttpClient {
  constructor(private readonly app: Application) {}

  get<T>(url: string) {
    return this.sendMockRequest<T>(url, {method: 'GET'});
  }

  post<T>(url: string, body: unknown) {
    return this.sendMockRequest<T>(url, {method: 'POST', body});
  }

  put<T>(url: string, body: unknown) {
    return this.sendMockRequest<T>(url, {method: 'PUT', body});
  }

  delete<T>(url: string) {
    return this.sendMockRequest<T>(url, {method: 'DELETE'});
  }

  private sendMockRequest<T = unknown>(
    url: string,
    {method, body}: {method: string; body?: unknown},
  ): Promise<{status: number; data?: T; text?: string}> {
    return new Promise((resolve, reject) => {
      let statusCode: number = 200;
      let streamText: string = '';

      const mockRequest = {method, url, body} as unknown as Request;
      const mockResponse = {
        status: (code: number) => {
          statusCode = code;
          return mockResponse;
        },
        send: (data: string | unknown) => {
          if (typeof data === 'string') {
            sendRespose(statusCode, undefined, data);
          } else {
            sendRespose(statusCode, data);
          }
        },
        json: (data: unknown) => {
          sendRespose(statusCode, data);
        },
        write: (streamChunk: string) => {
          streamText += streamChunk;
        },
        end: () => {
          sendRespose(statusCode, undefined, streamText);
        },
        setHeader: () => {},
        flushHeaders: () => {},
        redirect: (url: string) => {
          statusCode = 302;
          sendRespose(statusCode, undefined, url);
        },
      } as unknown as Response;

      const sendRespose = (
        statusCode: number,
        jsonData?: unknown,
        text?: string,
      ) => {
        if (statusCode > 399) {
          reject({
            response: {
              status: statusCode,
            },
            message: (jsonData as {error: string}).error,
          });
        }

        resolve({
          status: statusCode,
          data: jsonData as T,
          text,
        });
      };

      this.app(mockRequest, mockResponse);
    });
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
  let server: AdkWebServer;
  let client: MockHttpClient;

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
    server = new AdkWebServer({
      agentLoader,
      sessionService,
      memoryService,
      artifactService,
      port: 1234,
    });

    client = new MockHttpClient(server.app);
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
      const debugServer = new AdkWebServer({
        agentLoader,
        sessionService,
        memoryService,
        artifactService,
        port: 1235,
        serveDebugUI: true,
      });
      const debugClient = new MockHttpClient(debugServer.app);

      const response = await debugClient.get('/');
      expect(response.status).toBe(302);
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
});
