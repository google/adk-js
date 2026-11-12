/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type AuthConfig,
  AuthCredentialTypes,
  BaseLlm,
  BaseLlmConnection,
  Event,
  FunctionTool,
  getFunctionCalls,
  getFunctionResponses,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RestApiTool,
  Runner,
  type ToolContext,
} from '@google/adk';
import {type Content} from '@google/genai';
import * as http from 'http';
import {OpenAPIV3} from 'openapi-types';
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

class MockLlm extends BaseLlm {
  responses: LlmResponse[] = [];
  requests: Array<Pick<LlmRequest, 'contents' | 'config'>> = [];
  callCount = 0;

  constructor(responses: LlmResponse[]) {
    super({model: 'mock-llm'});
    this.responses = responses;
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(
      structuredClone({contents: request.contents, config: request.config}),
    );
    const response = this.responses[this.callCount];
    this.callCount++;
    if (response) {
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

describe('LlmAgent Auth Integration', () => {
  let server: http.Server;
  let port: number;
  let receivedHeaders: http.IncomingHttpHeaders | null = null;

  beforeAll(() => {
    server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      if (req.headers['x-api-key'] === 'secret-api-key') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({data: 'secured_data'}));
      } else {
        res.writeHead(401);
        res.end('Unauthorized');
      }
    });
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    receivedHeaders = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should request credentials, store them, and resume tool execution', async () => {
    // 1. Setup mock API
    const endpoint = {
      baseUrl: `http://localhost:${port}`,
      path: '/data',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: {type: 'object'},
            },
          },
        },
      },
    };
    const authScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };

    const tool = new RestApiTool(
      'mock_api_tool',
      'A mock tool requiring auth',
      endpoint,
      operation,
      authScheme,
    );

    // 2. Setup Agent and LLM
    // First turn: LLM calls the tool.
    // Second turn (after auth resolved): LLM returns final response using tool output.
    const toolCallResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'mock_api_tool',
              args: {},
              id: 'call_1',
            },
          },
        ],
      },
    };
    const finalResponse: LlmResponse = {
      content: {
        role: 'model',
        parts: [{text: 'I got the data: secured_data'}],
      },
    };

    const mockLlm = new MockLlm([toolCallResponse, finalResponse]);

    const agent = new LlmAgent({
      name: 'auth_agent',
      model: mockLlm,
      tools: [tool],
    });

    // 3. Run First Turn
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });

    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
    });

    const eventsTurn1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: {parts: [{text: 'Get secured data'}]},
    })) {
      eventsTurn1.push(event);
    }

    // Verify turn 1 events
    // Expect:
    // 1. Model response event (with tool call)
    // 2. Auth request event (adk_request_credential)
    // 3. Function response event (with pending status)

    expect(eventsTurn1.length).toBe(3);
    const modelResponseEvent = eventsTurn1[0];
    const authEvent = eventsTurn1[1];
    const functionResponseEvent = eventsTurn1[2];

    expect(getFunctionCalls(modelResponseEvent)[0].name).toBe('mock_api_tool');

    const authCalls = getFunctionCalls(authEvent);
    expect(authCalls.length).toBe(1);
    expect(authCalls[0].name).toBe('adk_request_credential');
    const authCallId = authCalls[0].id;

    const funcResponses = getFunctionResponses(functionResponseEvent);
    expect(funcResponses.length).toBe(1);
    expect(funcResponses[0].response).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });

    // 4. Run Second Turn (User provides credentials)
    // The user message should be a function response to `adk_request_credential`.
    const credentialResponseContent = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'adk_request_credential',
            id: authCallId,
            response: {
              authScheme,
              exchangedAuthCredential: {
                apiKey: 'secret-api-key',
              },
            },
          },
        },
      ],
    };

    const eventsTurn2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: credentialResponseContent,
    })) {
      eventsTurn2.push(event);
    }

    // Verify turn 2 events
    // Expect:
    // 1. Function response event (from retried tool, now success)
    // 2. Model response event (final response from LLM)

    expect(eventsTurn2.length).toBe(2);
    const retryToolResponseEvent = eventsTurn2[0];
    const finalModelResponseEvent = eventsTurn2[1];

    const retryResponses = getFunctionResponses(retryToolResponseEvent);
    expect(retryResponses.length).toBe(1);
    expect(retryResponses[0].name).toBe('mock_api_tool');
    expect(retryResponses[0].response).toEqual({data: 'secured_data'});

    expect(finalModelResponseEvent.content?.parts?.[0].text).toBe(
      'I got the data: secured_data',
    );

    expect(receivedHeaders).not.toBeNull();
    expect(receivedHeaders!['x-api-key']).toBe('secret-api-key');
  });

  it('should resume parallel tool calls one credential at a time across turns', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        const params = new URLSearchParams(
          typeof init?.body === 'string' ? init.body : '',
        );
        const code = params.get('code');
        const accessToken =
          code === 'auth_code_1'
            ? 'token_1'
            : code === 'auth_code_2'
              ? 'token_2'
              : undefined;
        if (!accessToken) {
          return new Response(JSON.stringify({error: 'invalid_grant'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
          });
        }
        return new Response(
          JSON.stringify({access_token: accessToken, token_type: 'Bearer'}),
          {status: 200, headers: {'Content-Type': 'application/json'}},
        );
      });

    const authConfig1: AuthConfig = {
      credentialKey: 'calendar_api_1',
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              'https://www.googleapis.com/auth/calendar':
                'See, edit, share, and permanently delete all the calendars you can access using Google Calendar',
            },
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'oauth_client_id_1',
          clientSecret: 'oauth_client_secret_1',
        },
      },
    };
    const authConfig2: AuthConfig = {
      credentialKey: 'calendar_api_2',
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              'https://www.googleapis.com/auth/calendar':
                'See, edit, share, and permanently delete all the calendars you can access using Google Calendar',
            },
          },
        },
      },
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'oauth_client_id_2',
          clientSecret: 'oauth_client_secret_2',
        },
      },
    };

    let functionInvoked = 0;

    const callExternalApi1 = new FunctionTool({
      name: 'call_external_api_1',
      description: 'Calls external API 1 requiring OAuth2 credentials.',
      execute: async (_args, toolContext?: ToolContext) => {
        functionInvoked += 1;
        if (!toolContext) {
          throw new Error('Expected toolContext to be provided.');
        }
        const authResponse = toolContext.getAuthResponse(authConfig1);
        if (!authResponse) {
          toolContext.requestCredential(authConfig1);
          return undefined;
        }
        expect(authResponse.oauth2?.accessToken).toBe('token_1');
        return 1;
      },
    });

    const callExternalApi2 = new FunctionTool({
      name: 'call_external_api_2',
      description: 'Calls external API 2 requiring OAuth2 credentials.',
      execute: async (_args, toolContext?: ToolContext) => {
        functionInvoked += 1;
        if (!toolContext) {
          throw new Error('Expected toolContext to be provided.');
        }
        const authResponse = toolContext.getAuthResponse(authConfig2);
        if (!authResponse) {
          toolContext.requestCredential(authConfig2);
          return undefined;
        }
        expect(authResponse.oauth2?.accessToken).toBe('token_2');
        return 2;
      },
    });

    const mockLlm = new MockLlm([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'id_1',
                name: 'call_external_api_1',
                args: {},
              },
            },
            {
              functionCall: {
                id: 'id_2',
                name: 'call_external_api_2',
                args: {},
              },
            },
          ],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'response after first credential'}],
        },
      },
      {
        content: {
          role: 'model',
          parts: [{text: 'final response'}],
        },
      },
    ]);

    const agent = new LlmAgent({
      name: 'root_agent',
      model: mockLlm,
      tools: [callExternalApi1, callExternalApi2],
    });
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user_1',
    });
    const runner = new Runner({
      appName: 'test_app',
      agent,
      sessionService,
    });

    const eventsTurn1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'test'}]},
    })) {
      eventsTurn1.push(event);
    }

    expect(functionInvoked).toBe(2);
    expect(mockLlm.requests).toHaveLength(1);
    expect(eventsTurn1).toHaveLength(3);

    const authCalls = getFunctionCalls(eventsTurn1[1]);
    expect(authCalls).toHaveLength(2);
    expect(authCalls[0].name).toBe('adk_request_credential');
    expect(authCalls[1].name).toBe('adk_request_credential');

    const firstCredentialMessage: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: authCalls[0].id,
            name: authCalls[0].name,
            response: {
              exchangedAuthCredential: {
                authType: AuthCredentialTypes.OAUTH2,
                oauth2: {
                  authCode: 'auth_code_1',
                },
              },
            },
          },
        },
      ],
    };

    const eventsTurn2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: firstCredentialMessage,
    })) {
      eventsTurn2.push(event);
    }

    expect(functionInvoked).toBe(3);
    expect(mockLlm.requests).toHaveLength(2);
    const turn2LastParts = mockLlm.requests[1].contents.at(-1)?.parts;
    expect(turn2LastParts).toHaveLength(2);
    expect(turn2LastParts?.[0]?.functionResponse).toEqual({
      id: 'id_1',
      name: 'call_external_api_1',
      response: {result: 1},
    });
    expect(turn2LastParts?.[1]?.functionResponse).toEqual({
      id: 'id_2',
      name: 'call_external_api_2',
      response: {result: undefined},
    });
    expect(eventsTurn2.at(-1)?.content?.parts?.[0]?.text).toBe(
      'response after first credential',
    );

    const secondCredentialMessage: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: authCalls[1].id,
            name: authCalls[1].name,
            response: {
              exchangedAuthCredential: {
                authType: AuthCredentialTypes.OAUTH2,
                oauth2: {
                  authCode: 'auth_code_2',
                },
              },
            },
          },
        },
      ],
    };

    const eventsTurn3: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'user_1',
      sessionId: session.id,
      newMessage: secondCredentialMessage,
    })) {
      eventsTurn3.push(event);
    }

    expect(functionInvoked).toBe(4);
    expect(mockLlm.requests).toHaveLength(3);
    const turn3LastParts = mockLlm.requests[2].contents.at(-1)?.parts;
    expect(turn3LastParts).toHaveLength(2);
    expect(turn3LastParts?.[0]?.functionResponse).toEqual({
      id: 'id_1',
      name: 'call_external_api_1',
      response: {result: 1},
    });
    expect(turn3LastParts?.[1]?.functionResponse).toEqual({
      id: 'id_2',
      name: 'call_external_api_2',
      response: {result: 2},
    });
    expect(eventsTurn3.at(-1)?.content?.parts?.[0]?.text).toBe(
      'final response',
    );
    fetchSpy.mockRestore();
  });
});
