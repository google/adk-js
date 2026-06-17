/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createRestApiTool,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';

describe('RestApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should configure credential key', () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    tool.configureCredentialKey('my-credential-key');

    expect((tool as unknown as {credentialKey: string}).credentialKey).toBe(
      'my-credential-key',
    );
  });

  it('should apply headers from provider', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const headerProvider = vi
      .fn()
      .mockReturnValue({'X-Custom-Header': 'custom-value'});
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
      undefined,
      undefined,
      {headerProvider},
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    const mockContext = {};
    await tool.runAsync({
      args: {},
      toolContext: mockContext as unknown as Context,
    });

    expect(headerProvider).toHaveBeenCalledWith(mockContext);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-Custom-Header': 'custom-value'}),
      }),
    );
  });

  it('should stringify object body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    // Mock operationParser to return a body parameter
    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'body', originalName: 'body', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {body: {foo: 'bar'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({foo: 'bar'}),
      }),
    );
  });

  it('should replace path parameters', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/users/{id}',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'id', originalName: 'id', paramLocation: 'path'},
    ];

    await tool.runAsync({
      args: {id: '123'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api.example.com/users/123',
      expect.anything(),
    );
  });

  it('should stringify bodyData', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'user', originalName: 'user', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {user: {name: 'Alice'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({user: {name: 'Alice'}}),
      }),
    );
  });

  it('should return pending if auth is pending', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const mockAuthHandler = {
      prepareAuthCredentials: async () => ({state: 'pending'}),
    };
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(
      mockAuthHandler as unknown as ToolAuthHandler,
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
  });

  it('should add header parameters', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'x-trace-id', originalName: 'X-Trace-Id', paramLocation: 'header'},
    ];

    await tool.runAsync({
      args: {'x-trace-id': 'trace-123'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-Trace-Id': 'trace-123'}),
      }),
    );
  });

  it('should get declaration', () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const mockSchema = {type: 'object', properties: {}};
    (
      tool as unknown as {operationParser: {getJsonSchema: () => unknown}}
    ).operationParser.getJsonSchema = () => mockSchema;

    const declaration = (
      tool as unknown as {_getDeclaration: () => unknown}
    )._getDeclaration();

    expect(declaration).toEqual({
      name: 'test_tool',
      description: 'description',
      parameters: mockSchema,
    });
  });

  it('should extract query parameters from path', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test?existing=param',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'new_param', originalName: 'new_param', paramLocation: 'query'},
    ];

    await tool.runAsync({
      args: {new_param: 'value'},
      toolContext: {} as unknown as Context,
    });

    // Verify URL contains both parameters
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://api.example.com/test'),
      expect.anything(),
    );
    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('existing=param');
    expect(calledUrl).toContain('new_param=value');
  });

  it('should handle application/x-www-form-urlencoded body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': {
            schema: {type: 'object'},
          },
        },
      },
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'foo', originalName: 'foo', paramLocation: 'body'},
      {name: 'baz', originalName: 'baz', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {foo: 'bar', baz: 'qux'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.any(URLSearchParams),
      }),
    );
    const calledBody = vi.mocked(globalThis.fetch).mock.calls[0][1]!
      .body as URLSearchParams;
    expect(calledBody.get('foo')).toBe('bar');
    expect(calledBody.get('baz')).toBe('qux');
  });

  it('should handle multipart/form-data body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {type: 'object'},
          },
        },
      },
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'foo', originalName: 'foo', paramLocation: 'body'},
      {name: 'file', originalName: 'file', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {foo: 'bar', file: 'content'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.any(FormData),
      }),
    );
    const calledBody = vi.mocked(globalThis.fetch).mock.calls[0][1]!
      .body as FormData;
    expect(calledBody.get('foo')).toBe('bar');
    expect(calledBody.get('file')).toBe('content');
  });

  it('should handle fetch error', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: Network error',
    });
  });

  it('should apply auth credentials to fetch request', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const authScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
      authScheme,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    const mockAuthHandler = {
      prepareAuthCredentials: async () => ({
        state: 'done',
        authCredential: {apiKey: 'secret_key'},
      }),
    };
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(
      mockAuthHandler as unknown as ToolAuthHandler,
    );

    await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-API-Key': 'secret_key'}),
      }),
    );
  });

  it('should fallback to JSON if no requestBody in spec', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'body', originalName: 'body', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {body: {foo: 'bar'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'Content-Type': 'application/json'}),
        body: JSON.stringify({foo: 'bar'}),
      }),
    );
  });
});

describe('RestApiTool Utilities', () => {
  describe('createRestApiTool', () => {
    it('should successfully create a RestApiTool instance', () => {
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/test',
        method: 'GET',
      };
      const operation: OpenAPIV3.OperationObject = {responses: {}};
      const parsed = {
        name: 'test_tool',
        description: 'description',
        endpoint,
        operation,
      };

      const tool = createRestApiTool(parsed);
      expect(tool).toBeInstanceOf(RestApiTool);
      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('description');
    });
  });

  describe('prepareRequestParams', () => {
    it('should map query, path, and header parameters correctly', () => {
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/users/{userId}/posts',
        method: 'GET',
      };
      const parameters = [
        {
          name: 'user_id',
          originalName: 'userId',
          paramLocation: 'path',
          paramSchema: {},
          required: true,
        },
        {
          name: 'q',
          originalName: 'q',
          paramLocation: 'query',
          paramSchema: {},
          required: false,
        },
        {
          name: 'x_trace_id',
          originalName: 'X-Trace-Id',
          paramLocation: 'header',
          paramSchema: {},
          required: false,
        },
      ];
      const args = {
        user_id: '123',
        q: 'search query',
        x_trace_id: 'trace-456',
      };

      const result = prepareRequestParams(endpoint, parameters, args);

      expect(result.url).toBe(
        'http://api.example.com/users/123/posts?q=search+query',
      );
      expect(result.headers).toEqual({
        'X-Trace-Id': 'trace-456',
      });
    });
  });

  describe('prepareRequestBody', () => {
    it('should format JSON body correctly', () => {
      const requestBody = {
        content: {
          'application/json': {
            schema: {type: 'object'},
          },
        },
      };
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBe(JSON.stringify(body));
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should fallback to JSON if no requestBody in spec', () => {
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(undefined, body, bodyData, headers);

      expect(result).toBe(JSON.stringify(body));
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });
  });
});
