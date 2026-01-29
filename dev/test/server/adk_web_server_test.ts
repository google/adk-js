import {
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  Session,
} from '@google/adk';
import type {Application, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

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
        send: (dataString: string) => {
          sendRespose(statusCode, undefined, dataString);
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

class TestAgent extends BaseAgent {
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

  describe('run_see', () => {
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
  });
});
