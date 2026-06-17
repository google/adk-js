/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, RestApiTool} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as http from 'http';
import {OpenAPIV3} from 'openapi-types';
import * as path from 'path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

describe('RestApiTool Auth E2E', () => {
  const envPath = path.resolve(__dirname, '../../../.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  let server: http.Server;
  let port: number;

  beforeAll(() => {
    server = http.createServer((req, res) => {
      if (req.headers['x-api-key'] === 'correct-key') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({result: 'success_data'}));
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

  it.skipIf(!hasAKey)(
    'should complete auth flow and tool execution with real LLM',
    async () => {
      const endpoint = {
        baseUrl: `http://localhost:${port}`,
        path: '/test',
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
        'test_auth_tool',
        'A tool that requires auth',
        endpoint,
        operation,
        authScheme,
      );

      const agent = new LlmAgent({
        name: 'auth_agent',
        instruction: 'Call the test_auth_tool to get the data.',
        model: 'gemini-2.5-flash',
        tools: [tool],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'auth_e2e_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'auth_e2e_test',
        userId: 'test_user',
      });

      // Start turn 1: ask agent to get data
      let authCallId = '';
      const eventsTurn1 = [];
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('Get data from test_auth_tool'),
      })) {
        eventsTurn1.push(event);
      }

      // We expect the agent to have tried to call the tool, failed with auth,
      // and yielded an auth request.
      const authRequests = eventsTurn1.filter((e) =>
        e.content?.parts?.some(
          (p) => p.functionCall?.name === 'adk_request_credential',
        ),
      );
      expect(authRequests.length).toBeGreaterThan(0);
      const authCall = authRequests[0].content?.parts?.find(
        (p) => p.functionCall?.name === 'adk_request_credential',
      )?.functionCall;
      expect(authCall).toBeDefined();
      authCallId = authCall!.id!;

      // Start turn 2: provide the credential
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
                  apiKey: 'correct-key',
                },
              },
            },
          },
        ],
      };

      const eventsTurn2 = [];
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: credentialResponseContent,
      })) {
        eventsTurn2.push(event);
      }

      // We expect the tool to have been retried with the credential,
      // succeeded, and the agent to have responded with the data.
      const toolResponses = eventsTurn2.filter((e) =>
        e.content?.parts?.some(
          (p) => p.functionResponse?.name === 'test_auth_tool',
        ),
      );
      expect(toolResponses.length).toBeGreaterThan(0);
      const toolResponse = toolResponses[0].content?.parts?.find(
        (p) => p.functionResponse?.name === 'test_auth_tool',
      )?.functionResponse;
      expect(toolResponse?.response).toEqual({result: 'success_data'});

      // Final response should contain some text indicating success
      const finalResponse = eventsTurn2[eventsTurn2.length - 1];
      expect(finalResponse.content?.parts?.[0].text).toBeDefined();
      expect(finalResponse.content?.parts?.[0].text?.length).toBeGreaterThan(0);
    },
    60000,
  );
});
