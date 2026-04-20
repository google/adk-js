/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {RestApiTool} from '../../../src/tools/openapi_tool/rest_api_tool.js';

describe('RestApiTool', () => {
  const mockOperation: OpenAPIV3.OperationObject = {
    operationId: 'createUser',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: {type: 'string'},
            },
          },
        },
      },
    },
    responses: {
      '200': {description: 'OK'},
    },
  };

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'application/json'},
      json: async () => ({success: true}),
    });
  });

  it('should handle request body in execution', async () => {
    const tool = new RestApiTool(
      'create_user',
      'Create a user',
      {baseUrl: 'https://api.example.com', path: '/users', method: 'POST'},
      mockOperation,
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await tool.runAsync({
      args: {name: 'John Doe'},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toEqual({success: true});
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({name: 'John Doe'}),
      }),
    );
  });

  it('should handle path parameters', async () => {
    const opWithPathParam: OpenAPIV3.OperationObject = {
      operationId: 'getUser',
      parameters: [
        {
          name: 'userId',
          in: 'path',
          required: true,
          schema: {type: 'string'},
        },
      ],
      responses: {'200': {description: 'OK'}},
    };

    const tool = new RestApiTool(
      'get_user',
      'Get a user',
      {
        baseUrl: 'https://api.example.com',
        path: '/users/{userId}',
        method: 'GET',
      },
      opWithPathParam,
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    await tool.runAsync({
      args: {user_id: '123'},
      toolContext: mockContext as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/users/123',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('should handle header parameters', async () => {
    const opWithHeaderParam: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [
        {
          name: 'X-Custom-Header',
          in: 'header',
          required: true,
          schema: {type: 'string'},
        },
      ],
      responses: {'200': {description: 'OK'}},
    };

    const tool = new RestApiTool(
      'test_op',
      'Test Op',
      {baseUrl: 'https://api.example.com', path: '/test', method: 'GET'},
      opWithHeaderParam,
      undefined,
      undefined,
      {preservePropertyNames: true},
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    await tool.runAsync({
      args: {'X-Custom-Header': 'my-value'},
      toolContext: mockContext as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Custom-Header': 'my-value',
        }),
      }),
    );
  });

  it('should handle explicit body parameter', async () => {
    const opWithExplicitBody: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
            },
          },
        },
      },
      responses: {'200': {description: 'OK'}},
    };

    const tool = new RestApiTool(
      'test_op',
      'Test Op',
      {baseUrl: 'https://api.example.com', path: '/test', method: 'POST'},
      opWithExplicitBody,
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const bodyObj = {some: 'data'};
    await tool.runAsync({
      args: {body: bodyObj},
      toolContext: mockContext as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        body: JSON.stringify(bodyObj),
      }),
    );
  });

  it('should return declaration', () => {
    const tool = new RestApiTool(
      'create_user',
      'Create a user',
      {baseUrl: 'https://api.example.com', path: '/users', method: 'POST'},
      mockOperation,
    );

    const declaration = tool._getDeclaration();
    expect(declaration.name).toBe('create_user');
    expect(declaration.description).toBe('Create a user');
    expect(declaration.parameters).toBeTruthy();
  });

  it('should return pending state when auth is pending', async () => {
    const tool = new RestApiTool(
      'test_op',
      'Test Op',
      {baseUrl: 'https://api.example.com', path: '/test', method: 'GET'},
      {operationId: 'testOp', responses: {}},
      {type: 'apiKey', in: 'header', name: 'key'},
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    const result = await tool.runAsync({
      args: {},
      toolContext: mockContext as unknown as Context,
    });

    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
  });

  it('should apply headers from headerProvider', async () => {
    const headerProvider = vi
      .fn()
      .mockReturnValue({'X-Dynamic-Header': 'dynamic-value'});
    const tool = new RestApiTool(
      'test_op',
      'Test Op',
      {baseUrl: 'https://api.example.com', path: '/test', method: 'GET'},
      {operationId: 'testOp', responses: {}},
      undefined,
      undefined,
      {headerProvider},
    );

    const mockContext = {
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
      state: {},
    };

    await tool.runAsync({
      args: {},
      toolContext: mockContext as unknown as Context,
    });

    expect(headerProvider).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Dynamic-Header': 'dynamic-value',
        }),
      }),
    );
  });
});
