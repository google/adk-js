/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  createSession,
  IntegrationConnectorTool,
  IntegrationConnectorToolOptions,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {Type} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TEST_AUTH_SCHEME: AuthScheme = {
  type: 'http',
  scheme: 'bearer',
};

const TEST_AUTH_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {
    scheme: 'bearer',
    credentials: {token: 'test_token'},
  },
};

function createRestTool(): RestApiTool {
  const operation: OpenAPIV3.OperationObject = {
    operationId: 'mock_rest_tool',
    description: 'Mock REST tool description.',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              userId: {type: 'string', description: 'User ID'},
              connectionName: {type: 'string'},
              host: {type: 'string'},
              serviceName: {type: 'string'},
              entity: {type: 'string'},
              operation: {type: 'string'},
              action: {type: 'string'},
              dynamicAuthConfig: {type: 'object'},
              pageSize: {type: 'integer'},
              pageToken: {type: 'string'},
              filterClause: {type: 'string'},
              sortByColumns: {type: 'array', items: {type: 'string'}},
            },
            required: [
              'userId',
              'pageSize',
              'pageToken',
              'filterClause',
              'sortByColumns',
              'connectionName',
              'dynamicAuthConfig',
            ],
          },
        },
      },
    },
    responses: {},
  };
  return new RestApiTool(
    'mock_rest_tool',
    'Mock REST tool description.',
    {baseUrl: 'https://example.com', path: '/v1/test', method: 'post'},
    operation,
    undefined,
    undefined,
    {preservePropertyNames: true},
  );
}

function createIntegrationTool(
  overrides: Partial<IntegrationConnectorToolOptions> = {},
): IntegrationConnectorTool {
  return new IntegrationConnectorTool({
    name: 'test_integration_tool',
    description: 'Test integration tool description.',
    connectionName: 'test-conn',
    connectionHost: 'test.example.com',
    connectionServiceName: 'test-service',
    entity: 'TestEntity',
    operation: 'LIST',
    action: 'TestAction',
    restApiTool: createRestTool(),
    ...overrides,
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('IntegrationConnectorTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes frozen EXCLUDE_FIELDS and OPTIONAL_FIELDS on IntegrationConnectorTool', () => {
    expect(IntegrationConnectorTool.EXCLUDE_FIELDS).toEqual([
      'connectionName',
      'serviceName',
      'host',
      'entity',
      'operation',
      'action',
    ]);
    expect(IntegrationConnectorTool.OPTIONAL_FIELDS).toEqual([
      'pageSize',
      'pageToken',
      'filterClause',
      'sortByColumns',
    ]);
    expect(Object.isFrozen(IntegrationConnectorTool.EXCLUDE_FIELDS)).toBe(true);
    expect(Object.isFrozen(IntegrationConnectorTool.OPTIONAL_FIELDS)).toBe(
      true,
    );
  });

  it('hides routing and dynamic auth fields from the declaration', () => {
    const restApiTool = createRestTool();
    const integrationTool = createIntegrationTool({restApiTool});

    const declaration = integrationTool._getDeclaration();

    expect(declaration.name).toBe('test_integration_tool');
    expect(declaration.description).toBe('Test integration tool description.');

    const params = declaration.parameters;
    expect(params?.type).toBe(Type.OBJECT);
    expect(params?.properties).toBeDefined();
    expect(Object.keys(params?.properties ?? {})).toEqual([
      'userId',
      'pageSize',
      'pageToken',
      'filterClause',
      'sortByColumns',
    ]);
    expect(params?.required).toEqual(['userId']);

    // Verify the underlying RestApiTool declaration is not mutated.
    const underlyingParams = restApiTool._getDeclaration().parameters;
    expect('connectionName' in (underlyingParams?.properties ?? {})).toBe(true);
    expect('dynamicAuthConfig' in (underlyingParams?.properties ?? {})).toBe(
      true,
    );
    expect(underlyingParams?.required).toContain('connectionName');
    expect(underlyingParams?.required).toContain('dynamicAuthConfig');
    expect(underlyingParams?.required).toContain('pageSize');
    expect(underlyingParams?.required).toContain('sortByColumns');
  });

  it('excludes camelCase routing fields and optional fields when preservePropertyNames is enabled', () => {
    const operation: OpenAPIV3.OperationObject = {
      operationId: 'mock_camel_tool',
      description: 'Mock camelCase REST tool.',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                userId: {type: 'string'},
                connectionName: {type: 'string'},
                serviceName: {type: 'string'},
                host: {type: 'string'},
                entity: {type: 'string'},
                operation: {type: 'string'},
                action: {type: 'string'},
                dynamicAuthConfig: {type: 'object'},
                pageSize: {type: 'integer'},
                pageToken: {type: 'string'},
                filterClause: {type: 'string'},
                sortByColumns: {type: 'array', items: {type: 'string'}},
              },
              required: [
                'userId',
                'connectionName',
                'serviceName',
                'dynamicAuthConfig',
                'pageSize',
                'pageToken',
                'filterClause',
                'sortByColumns',
              ],
            },
          },
        },
      },
      responses: {},
    };
    const restApiTool = new RestApiTool(
      'mock_camel_tool',
      'Mock camelCase REST tool.',
      {baseUrl: 'https://example.com', path: '/v1/test', method: 'post'},
      operation,
      undefined,
      undefined,
      {preservePropertyNames: true},
    );
    const integrationTool = createIntegrationTool({restApiTool});

    const declaration = integrationTool._getDeclaration();
    const params = declaration.parameters;
    expect(Object.keys(params?.properties ?? {})).toEqual([
      'userId',
      'pageSize',
      'pageToken',
      'filterClause',
      'sortByColumns',
    ]);
    expect(params?.required).toEqual(['userId']);
  });

  it('injects the connection details and delegates to the wrapped tool', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({status: 'success', data: 'mock_data'});
    const integrationTool = createIntegrationTool({restApiTool});
    const inputArgs = {userId: 'user123', pageSize: 10};
    const toolContext = createToolContext();

    const result = await integrationTool.runAsync({
      args: inputArgs,
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        userId: 'user123',
        pageSize: 10,
        connectionName: 'test-conn',
        host: 'test.example.com',
        serviceName: 'test-service',
        entity: 'TestEntity',
        operation: 'LIST',
        action: 'TestAction',
      },
      toolContext,
    });
    expect(result).toEqual({status: 'success', data: 'mock_data'});
    expect(inputArgs).toEqual({userId: 'user123', pageSize: 10});
  });

  it('injects dynamicAuthConfig when the credential has a token', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({status: 'success', data: 'mock_data'});
    vi.spyOn(
      ToolAuthHandler.prototype,
      'prepareAuthCredentials',
    ).mockResolvedValue({
      state: 'done',
      authCredential: TEST_AUTH_CREDENTIAL,
    });
    const integrationTool = createIntegrationTool({
      restApiTool,
      authScheme: TEST_AUTH_SCHEME,
      authCredential: TEST_AUTH_CREDENTIAL,
    });
    const toolContext = createToolContext();

    const result = await integrationTool.runAsync({
      args: {userId: 'user123', pageSize: 10, sortByColumns: ['a', 'b']},
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        userId: 'user123',
        pageSize: 10,
        sortByColumns: ['a', 'b'],
        connectionName: 'test-conn',
        host: 'test.example.com',
        serviceName: 'test-service',
        entity: 'TestEntity',
        operation: 'LIST',
        action: 'TestAction',
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'test_token',
        },
      },
      toolContext,
    });
    expect(result).toEqual({status: 'success', data: 'mock_data'});
  });

  it.each([
    ['has no token', {}],
    ['has an empty token', {token: ''}],
  ])(
    'returns an error without calling restApiTool when the credential %s',
    async (_, credentials) => {
      const restApiTool = createRestTool();
      const runAsyncSpy = vi
        .spyOn(restApiTool, 'runAsync')
        .mockResolvedValue({status: 'success', data: 'mock_data'});
      const credentialWithoutToken: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials,
        },
      };
      vi.spyOn(
        ToolAuthHandler.prototype,
        'prepareAuthCredentials',
      ).mockResolvedValue({
        state: 'done',
        authCredential: credentialWithoutToken,
      });
      const integrationTool = createIntegrationTool({
        restApiTool,
        authScheme: TEST_AUTH_SCHEME,
        authCredential: credentialWithoutToken,
      });
      const toolContext = createToolContext();

      const result = await integrationTool.runAsync({
        args: {userId: 'user123', pageSize: 10},
        toolContext,
      });

      expect(runAsyncSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        error: 'The resolved end-user credential has no access token.',
      });
    },
  );

  it('returns a pending authorization response without calling restApiTool when auth state is pending', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi.spyOn(restApiTool, 'runAsync');
    vi.spyOn(
      ToolAuthHandler.prototype,
      'prepareAuthCredentials',
    ).mockResolvedValue({
      state: 'pending',
    });
    const integrationTool = createIntegrationTool({
      restApiTool,
      authScheme: TEST_AUTH_SCHEME,
      authCredential: TEST_AUTH_CREDENTIAL,
    });
    const toolContext = createToolContext();

    const result = await integrationTool.runAsync({
      args: {userId: 'user123', pageSize: 10},
      toolContext,
    });

    expect(runAsyncSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
  });

  it('omits entity, operation, and action when empty or unset', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({status: 'success'});
    const integrationTool = createIntegrationTool({
      restApiTool,
      entity: '',
      operation: undefined,
      action: '',
    });
    const toolContext = createToolContext();

    await integrationTool.runAsync({
      args: {userId: 'user123'},
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        userId: 'user123',
        connectionName: 'test-conn',
        host: 'test.example.com',
        serviceName: 'test-service',
      },
      toolContext,
    });
  });
});
