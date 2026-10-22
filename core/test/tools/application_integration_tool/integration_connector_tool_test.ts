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
              user_id: {type: 'string', description: 'User ID'},
              connection_name: {type: 'string'},
              host: {type: 'string'},
              service_name: {type: 'string'},
              entity: {type: 'string'},
              operation: {type: 'string'},
              action: {type: 'string'},
              dynamic_auth_config: {type: 'object'},
              page_size: {type: 'integer'},
              page_token: {type: 'string'},
              filter: {type: 'string'},
            },
            required: [
              'user_id',
              'page_size',
              'page_token',
              'filter',
              'connection_name',
              'dynamic_auth_config',
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
      'connection_name',
      'connectionName',
      'service_name',
      'serviceName',
      'host',
      'entity',
      'operation',
      'action',
    ]);
    expect(IntegrationConnectorTool.OPTIONAL_FIELDS).toEqual([
      'page_size',
      'pageSize',
      'page_token',
      'pageToken',
      'filter',
      'filter_clause',
      'filterClause',
    ]);
    expect(Object.isFrozen(IntegrationConnectorTool.EXCLUDE_FIELDS)).toBe(true);
    expect(Object.isFrozen(IntegrationConnectorTool.OPTIONAL_FIELDS)).toBe(
      true,
    );
  });

  it('test_get_declaration', () => {
    const restApiTool = createRestTool();
    const integrationTool = createIntegrationTool({restApiTool});

    const declaration = integrationTool._getDeclaration();

    expect(declaration.name).toBe('test_integration_tool');
    expect(declaration.description).toBe('Test integration tool description.');

    const params = declaration.parameters;
    expect(params?.type).toBe(Type.OBJECT);
    expect(params?.properties).toBeDefined();
    expect('user_id' in (params?.properties ?? {})).toBe(true);
    expect('connection_name' in (params?.properties ?? {})).toBe(false);
    expect('host' in (params?.properties ?? {})).toBe(false);
    expect('service_name' in (params?.properties ?? {})).toBe(false);
    expect('entity' in (params?.properties ?? {})).toBe(false);
    expect('operation' in (params?.properties ?? {})).toBe(false);
    expect('action' in (params?.properties ?? {})).toBe(false);
    expect('dynamic_auth_config' in (params?.properties ?? {})).toBe(false);
    expect('page_size' in (params?.properties ?? {})).toBe(true);
    expect('page_token' in (params?.properties ?? {})).toBe(true);
    expect('filter' in (params?.properties ?? {})).toBe(true);

    expect(params?.required).toEqual(['user_id']);

    // Verify the underlying RestApiTool declaration is not mutated.
    const underlyingParams = restApiTool._getDeclaration().parameters;
    expect('connection_name' in (underlyingParams?.properties ?? {})).toBe(
      true,
    );
    expect('dynamic_auth_config' in (underlyingParams?.properties ?? {})).toBe(
      true,
    );
    expect(underlyingParams?.required).toContain('connection_name');
    expect(underlyingParams?.required).toContain('dynamic_auth_config');
    expect(underlyingParams?.required).toContain('page_size');
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
                filter_clause: {type: 'string'},
              },
              required: [
                'userId',
                'connectionName',
                'serviceName',
                'dynamicAuthConfig',
                'pageSize',
                'pageToken',
                'filterClause',
                'filter_clause',
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
      'filter_clause',
    ]);
    expect(params?.required).toEqual(['userId']);
  });

  it('test_run_async', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({status: 'success', data: 'mock_data'});
    const integrationTool = createIntegrationTool({restApiTool});
    const inputArgs = {user_id: 'user123', page_size: 10};
    const toolContext = createToolContext();

    const result = await integrationTool.runAsync({
      args: inputArgs,
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        user_id: 'user123',
        page_size: 10,
        connection_name: 'test-conn',
        connectionName: 'test-conn',
        host: 'test.example.com',
        service_name: 'test-service',
        serviceName: 'test-service',
        entity: 'TestEntity',
        operation: 'LIST',
        action: 'TestAction',
      },
      toolContext,
    });
    expect(result).toEqual({status: 'success', data: 'mock_data'});
    expect(inputArgs).toEqual({user_id: 'user123', page_size: 10});
  });

  it('injects dynamic_auth_config when authScheme and authCredential provide a token', async () => {
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
      args: {user_id: 'user123', page_size: 10},
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        user_id: 'user123',
        page_size: 10,
        connection_name: 'test-conn',
        connectionName: 'test-conn',
        host: 'test.example.com',
        service_name: 'test-service',
        serviceName: 'test-service',
        entity: 'TestEntity',
        operation: 'LIST',
        action: 'TestAction',
        dynamic_auth_config: {
          'oauth2_auth_code_flow.access_token': 'test_token',
        },
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'test_token',
        },
      },
      toolContext,
    });
    expect(result).toEqual({status: 'success', data: 'mock_data'});
  });

  it('injects an empty object in dynamic_auth_config when the credential has no token', async () => {
    const restApiTool = createRestTool();
    const runAsyncSpy = vi
      .spyOn(restApiTool, 'runAsync')
      .mockResolvedValue({status: 'success', data: 'mock_data'});
    const credentialWithoutToken: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {},
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
      args: {user_id: 'user123', page_size: 10},
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        user_id: 'user123',
        page_size: 10,
        connection_name: 'test-conn',
        connectionName: 'test-conn',
        host: 'test.example.com',
        service_name: 'test-service',
        serviceName: 'test-service',
        entity: 'TestEntity',
        operation: 'LIST',
        action: 'TestAction',
        dynamic_auth_config: {
          'oauth2_auth_code_flow.access_token': {},
        },
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': {},
        },
      },
      toolContext,
    });
    expect(result).toEqual({status: 'success', data: 'mock_data'});
  });

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
      args: {user_id: 'user123', page_size: 10},
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
      args: {user_id: 'user123'},
      toolContext,
    });

    expect(runAsyncSpy).toHaveBeenCalledExactlyOnceWith({
      args: {
        user_id: 'user123',
        connection_name: 'test-conn',
        connectionName: 'test-conn',
        host: 'test.example.com',
        service_name: 'test-service',
        serviceName: 'test-service',
      },
      toolContext,
    });
  });
});
