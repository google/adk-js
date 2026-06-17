/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  RestApiTool,
  Runner,
} from '@google/adk';
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
  callCount = 0;

  constructor(responses: LlmResponse[]) {
    super({model: 'mock-llm'});
    this.responses = responses;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
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

    // Wait, let's trace what happens in turn 2:
    // User sends credential response.
    // Runner appends it to session.
    // Runner calls agent.runAsync.
    // LlmAgent runs request processors.
    // AuthPreprocessor runs:
    //   - finds last event (user credential response)
    //   - extracts credential
    //   - stores it in state
    //   - retries 'mock_api_tool' (since it was pending)
    //   - 'mock_api_tool' runs, now has credentials, calls fetch, succeeds.
    //   - AuthPreprocessor yields the successful function response event.
    //   - AuthPreprocessor returns (short-circuits).
    // Step 1 of agent.runAsync finished.
    // LlmAgent loop continues because last event yielded (function response) is not final.
    // Step 2:
    //   - AuthPreprocessor runs, returns early (no new user credential response).
    //   - CONTENT_REQUEST_PROCESSOR runs, includes the successful function response in history.
    //   - LLM is called. MockLlm returns `finalResponse`.
    //   - LlmAgent yields model response event.
    //   - LlmAgent loop finishes (finalResponse is final).

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
});
