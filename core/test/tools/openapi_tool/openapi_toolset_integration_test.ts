/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
} from '@google/adk';
import * as fs from 'fs';
import {OpenAPIV3} from 'openapi-types';
import * as path from 'path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

describe('OpenAPIToolset Integration', () => {
  let truanonSpec: string;

  beforeEach(() => {
    const specPath = path.resolve(__dirname, 'fixtures/truanon.yaml');
    truanonSpec = fs.readFileSync(specPath, 'utf8');

    // Mock global fetch
    globalThis.fetch = vi.fn();
  });

  it('should parse truanon spec and create tools', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('get_profile');
    expect(toolNames).toContain('get_token');
  });

  it('should execute a tool with mocked fetch', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    expect(getProfileTool).toBeTruthy();

    const mockResponse = {status: 'success', data: {confirmed: true}};
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      headers: {get: () => 'application/json'},
      json: async () => mockResponse,
    });

    // Mock context
    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toEqual(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://staging.truanon.com/api/get_profile?id=user1&service=myservice',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('should handle non-JSON response', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'plain text response',
    });

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toBe('plain text response');
  });

  it('should handle fetch error', async () => {
    const toolset = new OpenAPIToolset({
      specStr: truanonSpec,
      specType: 'yaml',
    });
    const tools = await toolset.getTools();
    const getProfileTool = tools.find((t) => t.name === 'get_profile');

    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Network error'));

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await getProfileTool!.runAsync({
      args: {id: 'user1', service: 'myservice'},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: Network error',
    });
  });

  it('should keep a malicious path argument inside the declared endpoint', async () => {
    const apiKeyScheme: OpenAPIV3.ApiKeySecurityScheme = {
      type: 'apiKey',
      in: 'query',
      name: 'key',
    };
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.3',
      info: {title: 'Users API', version: '1.0.0'},
      servers: [{url: 'https://api.example.com'}],
      security: [{ApiKeyAuth: []}],
      paths: {
        '/v1/users/{user_id}': {
          get: {
            operationId: 'getUser',
            parameters: [
              {
                name: 'user_id',
                in: 'path',
                required: true,
                schema: {type: 'string'},
              },
            ],
            responses: {'200': {description: 'ok'}},
          },
        },
      },
      components: {securitySchemes: {ApiKeyAuth: apiKeyScheme}},
    };
    const toolset = new OpenAPIToolset({
      specStr: JSON.stringify(spec),
      specType: 'json',
      authScheme: apiKeyScheme,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-api-key',
      },
    });
    const tools = await toolset.getTools();
    const getUserTool = tools.find((t) => t.name === 'get_user');
    if (!getUserTool) expect.fail('get_user tool was not created');

    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('{}', {headers: {'content-type': 'application/json'}}),
    );

    await getUserTool.runAsync({
      args: {user_id: '../../admin/export'},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({id: 'session-1', appName: 'test_app'}),
          pluginManager: new PluginManager(),
        }),
      }),
    });

    const [calledUrl] = vi.mocked(globalThis.fetch).mock.calls[0];
    if (typeof calledUrl !== 'string') {
      expect.fail('fetch was not called with a URL string');
    }
    const requestUrl = new URL(calledUrl);
    expect(requestUrl.host).toBe('api.example.com');
    expect(requestUrl.pathname).toBe('/v1/users/..%2F..%2Fadmin%2Fexport');
    expect(requestUrl.searchParams.get('key')).toBe('test-api-key');
  });
});
