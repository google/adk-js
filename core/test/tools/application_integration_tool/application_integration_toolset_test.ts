/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  actionRequest,
  ApplicationIntegrationToolset,
  ApplicationIntegrationToolsetOptions,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  ConnectionsClient,
  CONNECTOR_BASE_SPEC,
  ConnectorSpec,
  Context,
  createSession,
  getActionOperation,
  IntegrationClient,
  IntegrationConnectorTool,
  InvocationContext,
  listOperation,
  listOperationRequest,
  LlmAgent,
  logger,
  OpenAPIToolset,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const TEST_AUTH_SCHEME: AuthScheme = {
  type: 'http',
  scheme: 'bearer',
};

const TEST_AUTH_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {
    scheme: 'bearer',
    credentials: {token: 'dynamic_user_token'},
  },
};

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(function () {
    return {
      getAccessToken: vi.fn().mockResolvedValue('test_token'),
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({token: 'tool_token'}),
      }),
    };
  }),
}));

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const CONNECTION = 'test-connection';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const VALIDATION_MESSAGE =
  'Either integration or (connection and (entityOperations or actions)) should be provided.';

const INTEGRATION_SPEC = {
  openapi: '3.0.0',
  info: {title: 'Integration API', version: '1'},
  servers: [{url: 'https://example.com'}],
  paths: {
    '/things': {get: {operationId: 'getThings', summary: 'Get things'}},
  },
};

const fetchMock = vi.fn<typeof fetch>();

function connectionSpec(): ConnectorSpec {
  const spec = structuredClone(CONNECTOR_BASE_SPEC);
  spec.paths['/v2/execute#list_Issues'] = listOperation({entity: 'Issues'});
  spec.components.schemas['list_Issues_Request'] = listOperationRequest();
  return spec;
}

function actionSpec(): ConnectorSpec {
  const spec = structuredClone(CONNECTOR_BASE_SPEC);
  spec.paths['/v2/execute#ExecuteCustomQuery'] = getActionOperation({
    action: 'ExecuteCustomQuery',
    operation: 'EXECUTE_ACTION',
    actionDisplayName: 'ExecuteCustomQuery',
  });
  spec.components.schemas['ExecuteCustomQuery_Request'] =
    actionRequest('ExecuteCustomQuery');
  return spec;
}

function toolset(
  options: Partial<ApplicationIntegrationToolsetOptions>,
): ApplicationIntegrationToolset {
  return new ApplicationIntegrationToolset({
    project: PROJECT,
    location: LOCATION,
    ...options,
  });
}

function integrationToolset(
  options: Partial<ApplicationIntegrationToolsetOptions> = {},
): ApplicationIntegrationToolset {
  return toolset({
    integration: 'test-integration',
    triggers: ['test-trigger'],
    ...options,
  });
}

function toolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200});
}

describe('ApplicationIntegrationToolset', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('integration mode', () => {
    it('builds tools from the integration spec', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);
      const connectionSpy = vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForConnection',
      );
      const detailsSpy = vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      );

      const tools = await integrationToolset().getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(integrationSpy).toHaveBeenCalledOnce();
      expect(connectionSpy).not.toHaveBeenCalled();
      expect(detailsSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['a single trigger in triggers', ['test-trigger']],
      ['multiple triggers in triggers', ['test-trigger', 'test-trigger2']],
      ['an empty triggers array', []],
    ])('builds tools when configured with %s', async (_, triggers) => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);

      const tools = await toolset({
        integration: 'test-integration',
        triggers,
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('initialization with integration and trigger', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);

      const tools = await toolset({
        integration: 'test-integration',
        triggers: ['test-trigger'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('initialization with integration and list of triggers', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue({
          ...INTEGRATION_SPEC,
          paths: {
            '/things': {get: {operationId: 'getThings', summary: 'Get things'}},
            '/other': {get: {operationId: 'getOther', summary: 'Get other'}},
          },
        });

      const tools = await toolset({
        integration: 'test-integration',
        triggers: ['test-trigger1', 'test-trigger2'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'get_things',
        'get_other',
      ]);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('initialization with integration and empty trigger list', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);

      const tools = await toolset({
        integration: 'test-integration',
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('filters tools in integration mode using a predicate or string array', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue({
        ...INTEGRATION_SPEC,
        paths: {
          '/things': {get: {operationId: 'getThings', summary: 'Get things'}},
          '/other': {get: {operationId: 'getOther', summary: 'Get other'}},
        },
      });

      const filteredByPredicate = await integrationToolset({
        toolFilter: (tool) => tool.name === 'get_things',
      }).getTools();
      const filteredByArray = await integrationToolset({
        toolFilter: ['get_other'],
      }).getTools();

      expect(filteredByPredicate.map((tool) => tool.name)).toEqual([
        'get_things',
      ]);
      expect(filteredByArray.map((tool) => tool.name)).toEqual(['get_other']);
    });

    it('evaluates a context-dependent toolFilter predicate per getTools call without caching filtered results', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue({
          ...INTEGRATION_SPEC,
          paths: {
            '/things': {get: {operationId: 'getThings', summary: 'Get things'}},
            '/other': {get: {operationId: 'getOther', summary: 'Get other'}},
          },
        });
      const sharedToolset = integrationToolset({
        toolFilter: (tool, context) =>
          tool.name === context?.state.get('allowedTool'),
      });
      const firstContext = new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-1',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({
            id: 'session-1',
            appName: 'test_app',
            state: {allowedTool: 'get_things'},
          }),
          pluginManager: new PluginManager(),
        }),
      });
      const secondContext = new Context({
        invocationContext: new InvocationContext({
          invocationId: 'invocation-2',
          agent: new LlmAgent({name: 'test_agent'}),
          session: createSession({
            id: 'session-2',
            appName: 'test_app',
            state: {allowedTool: 'get_other'},
          }),
          pluginManager: new PluginManager(),
        }),
      });

      const firstTools = await sharedToolset.getTools(firstContext);
      const secondTools = await sharedToolset.getTools(secondContext);

      expect(firstTools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(secondTools.map((tool) => tool.name)).toEqual(['get_other']);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('fetches nothing until getTools is called', () => {
      const integrationSpy = vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      );

      integrationToolset();

      expect(integrationSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('connection mode', () => {
    it('passes toolNamePrefix and toolInstructions and wraps entity tools in IntegrationConnectorTool', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: 'test.host',
        authOverrideEnabled: false,
      });
      const connectionSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForConnection')
        .mockResolvedValue(connectionSpec());
      const integrationSpy = vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      );

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST', 'GET']},
        toolNamePrefix: 'My Connection Tool',
        toolInstructions: 'Use this tool to manage entities.',
      }).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith(
        'My Connection Tool',
        'Use this tool to manage entities.',
      );
      expect(integrationSpy).not.toHaveBeenCalled();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toBeInstanceOf(IntegrationConnectorTool);
      expect(tools[0]).toEqual(
        expect.objectContaining({
          name: 'list_issues',
          entity: 'Issues',
          operation: 'LIST_ENTITIES',
        }),
      );
    });

    it('passes toolNamePrefix and toolInstructions and wraps action tools in IntegrationConnectorTool', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'custom-service',
        host: 'custom.host',
        authOverrideEnabled: false,
      });
      const connectionSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForConnection')
        .mockResolvedValue(actionSpec());

      const tools = await toolset({
        connection: CONNECTION,
        actions: ['ExecuteCustomQuery'],
        toolNamePrefix: 'My Actions Tool',
        toolInstructions: 'Use this tool.',
      }).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith(
        'My Actions Tool',
        'Use this tool.',
      );
      expect(tools).toHaveLength(1);
      expect(tools[0]).toBeInstanceOf(IntegrationConnectorTool);
      expect(tools[0]).toEqual(
        expect.objectContaining({
          name: 'execute_custom_query',
          action: 'ExecuteCustomQuery',
          operation: 'EXECUTE_ACTION',
        }),
      );
    });

    it('defaults the tool name and instructions to empty strings', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'svc',
        host: '',
        authOverrideEnabled: false,
      });
      const connectionSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForConnection')
        .mockResolvedValue(connectionSpec());

      await toolset({connection: CONNECTION, actions: ['a']}).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith('', '');
    });

    it('passes authScheme and authCredential to IntegrationConnectorTool when authOverrideEnabled is true', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: 'test.host',
        authOverrideEnabled: true,
      });
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForConnection',
      ).mockResolvedValue(connectionSpec());
      const warnSpy = vi.spyOn(logger, 'warn');

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        authScheme: TEST_AUTH_SCHEME,
        authCredential: TEST_AUTH_CREDENTIAL,
      }).getTools();

      expect(warnSpy).not.toHaveBeenCalled();
      expect(tools).toHaveLength(1);
      const connectorTool = tools[0] as IntegrationConnectorTool;
      expect(connectorTool.authScheme).toEqual(TEST_AUTH_SCHEME);
      expect(connectorTool.authCredential).toEqual(TEST_AUTH_CREDENTIAL);
    });

    it('warns and omits authScheme and authCredential when authOverrideEnabled is false', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: 'test.host',
        authOverrideEnabled: false,
      });
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForConnection',
      ).mockResolvedValue(connectionSpec());
      const warnSpy = vi.spyOn(logger, 'warn');

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        authScheme: TEST_AUTH_SCHEME,
        authCredential: TEST_AUTH_CREDENTIAL,
      }).getTools();

      expect(warnSpy).toHaveBeenCalledWith(
        'Authentication schema and credentials are not used because authOverrideEnabled is not enabled in the connection.',
      );
      expect(tools).toHaveLength(1);
      const connectorTool = tools[0] as IntegrationConnectorTool;
      expect(connectorTool.authScheme).toBeUndefined();
      expect(connectorTool.authCredential).toBeUndefined();
    });

    it('filters tools in connection mode using a predicate or string array', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: 'test.host',
        authOverrideEnabled: false,
      });
      const spec = connectionSpec();
      spec.paths['/v2/execute#ExecuteCustomQuery'] = getActionOperation({
        action: 'ExecuteCustomQuery',
        operation: 'EXECUTE_ACTION',
        actionDisplayName: 'ExecuteCustomQuery',
      });
      spec.components.schemas['ExecuteCustomQuery_Request'] =
        actionRequest('ExecuteCustomQuery');
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForConnection',
      ).mockResolvedValue(spec);

      const filteredByPredicate = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        actions: ['ExecuteCustomQuery'],
        toolFilter: (tool) => tool.name === 'list_issues',
      }).getTools();
      const filteredByArray = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        actions: ['ExecuteCustomQuery'],
        toolFilter: ['execute_custom_query'],
      }).getTools();

      expect(filteredByPredicate.map((tool) => tool.name)).toEqual([
        'list_issues',
      ]);
      expect(filteredByArray.map((tool) => tool.name)).toEqual([
        'execute_custom_query',
      ]);
    });
  });

  describe('validation', () => {
    it.each<[string, Partial<ApplicationIntegrationToolsetOptions>]>([
      ['nothing', {}],
      ['triggers without an integration', {triggers: ['test']}],
      ['a connection alone', {connection: 'test'}],
      [
        'a connection with empty entity operations',
        {connection: 'test', entityOperations: {}},
      ],
      ['a connection with empty actions', {connection: 'test', actions: []}],
    ])('rejects %s', (_, options) => {
      expect(() => toolset(options)).toThrow(VALIDATION_MESSAGE);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts an integration without triggers', () => {
      expect(() => toolset({integration: 'test-integration'})).not.toThrow();
    });
  });

  describe('credentials', () => {
    it('gives the tools the service account', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue(INTEGRATION_SPEC);
      const credentialSpy = vi.spyOn(
        RestApiTool.prototype,
        'configureAuthCredential',
      );
      const schemeSpy = vi.spyOn(RestApiTool.prototype, 'configureAuthScheme');
      const serviceAccountJson = JSON.stringify({
        type: 'service_account',
        project_id: 'dummy',
        private_key_id: 'dummy',
        private_key: 'dummy',
        client_email: 'test@example.com',
        client_id: '131331543646416',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
      });

      await integrationToolset({serviceAccountJson}).getTools();

      expect(credentialSpy).toHaveBeenCalledOnce();
      const credential = credentialSpy.mock.calls[0][0];
      expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(
        credential.serviceAccount?.serviceAccountCredential?.clientEmail,
      ).toBe('test@example.com');
      expect(credential.serviceAccount?.scopes).toEqual([CLOUD_PLATFORM_SCOPE]);
      expect(credential.serviceAccount?.useDefaultCredential).toBeUndefined();
      expect(schemeSpy).toHaveBeenCalledExactlyOnceWith({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
    });

    it('gives the tools default credentials without a key', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue(INTEGRATION_SPEC);
      const credentialSpy = vi.spyOn(
        RestApiTool.prototype,
        'configureAuthCredential',
      );
      const schemeSpy = vi.spyOn(RestApiTool.prototype, 'configureAuthScheme');

      await integrationToolset().getTools();

      expect(credentialSpy).toHaveBeenCalledExactlyOnceWith({
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {
          useDefaultCredential: true,
          scopes: [CLOUD_PLATFORM_SCOPE],
        },
      });
      expect(schemeSpy).toHaveBeenCalledExactlyOnceWith({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
    });

    it('rejects a service-account key that is not a JSON object', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue(INTEGRATION_SPEC);

      await expect(
        integrationToolset({serviceAccountJson: '[]'}).getTools(),
      ).rejects.toThrow('serviceAccountJson must hold a JSON object.');
    });
  });

  describe('getTools', () => {
    it('loads once and returns the same tools on later calls', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);
      const applicationToolset = integrationToolset();

      const first = await applicationToolset.getTools();
      const second = await applicationToolset.getTools();

      expect(second).toEqual(first);
      expect(second[0]).toBe(first[0]);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('shares one load between concurrent calls', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockResolvedValue(INTEGRATION_SPEC);
      const applicationToolset = integrationToolset();

      const [first, second] = await Promise.all([
        applicationToolset.getTools(),
        applicationToolset.getTools(),
      ]);

      expect(second[0]).toBe(first[0]);
      expect(integrationSpy).toHaveBeenCalledOnce();
    });

    it('retries after a failed load', async () => {
      const integrationSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForIntegration')
        .mockRejectedValueOnce(new Error('Request error: unavailable'))
        .mockResolvedValueOnce(INTEGRATION_SPEC);
      const applicationToolset = integrationToolset();

      await expect(applicationToolset.getTools()).rejects.toThrow(
        'Request error: unavailable',
      );
      const tools = await applicationToolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get_things']);
      expect(integrationSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps the last tool when two operations share a name', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue({
        ...INTEGRATION_SPEC,
        paths: {
          '/first': {get: {operationId: 'duplicate', description: 'First'}},
          '/second': {get: {operationId: 'duplicate', description: 'Second'}},
        },
      });

      const tools = await integrationToolset().getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].description).toContain('Second');
    });

    it('closes without error', async () => {
      await expect(integrationToolset().close()).resolves.toBeUndefined();
    });

    it('delegates close to created OpenAPIToolsets', async () => {
      vi.spyOn(
        IntegrationClient.prototype,
        'getOpenApiSpecForIntegration',
      ).mockResolvedValue(INTEGRATION_SPEC);
      const closeSpy = vi.spyOn(OpenAPIToolset.prototype, 'close');
      const applicationToolset = integrationToolset();

      await expect(applicationToolset.close()).resolves.toBeUndefined();
      expect(closeSpy).not.toHaveBeenCalled();

      await applicationToolset.getTools();
      await expect(applicationToolset.close()).resolves.toBeUndefined();
      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });

  describe('with real clients', () => {
    it('turns a connector spec into one tool per operation', async () => {
      const connectionUrl = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
      const routes: Record<string, unknown> = {
        [`${connectionUrl}?view=BASIC`]: {
          name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
          serviceDirectory: 'test-service',
        },
        [`${connectionUrl}/connectionSchemaMetadata:getEntityType?entityId=Issues`]:
          {name: 'operations/entity'},
        'https://connectors.googleapis.com/v1/operations/entity': {
          done: true,
          response: {
            jsonSchema: {
              type: 'object',
              properties: {summary: {type: ['null', 'string']}},
            },
            operations: ['LIST', 'GET'],
          },
        },
        [`${connectionUrl}/connectionSchemaMetadata:getAction?actionId=ExecuteCustomQuery`]:
          {name: 'operations/action'},
        'https://connectors.googleapis.com/v1/operations/action': {
          done: true,
          response: {
            inputJsonSchema: {type: 'object'},
            outputJsonSchema: {type: 'object'},
            displayName: 'ExecuteCustomQuery',
          },
        },
      };
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (!(url in routes)) {
          throw new Error(`No route for ${url}`);
        }
        return jsonResponse(routes[url]);
      });

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        actions: ['ExecuteCustomQuery'],
        toolNamePrefix: 'tracker',
        toolInstructions: 'Custom instruction.',
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'tracker_list_issues',
        'tracker_execute_custom_query',
      ]);
      expect(tools[0]).toBeInstanceOf(IntegrationConnectorTool);
      expect(tools[1]).toBeInstanceOf(IntegrationConnectorTool);
      expect(tools[0].description).toContain(
        'Returns the list of Issues data.',
      );
      expect(tools[0].description).toContain('Custom instruction.');

      expect(
        Object.keys(tools[0]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual(['filter_clause', 'page_size', 'page_token']);
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({connectorOutputPayload: []}));
      await tools[0].runAsync({
        args: {},
        toolContext: toolContext(),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe(
        `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/ExecuteConnection:execute`,
      );
      expect(requestUrl.searchParams.get('triggerId')).toBe(
        'api_trigger/ExecuteConnection',
      );
      expect(String(url)).not.toMatch(/#|%23/);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer tool_token',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        operation: 'LIST_ENTITIES',
        entity: 'Issues',
        connectionName: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: '',
      });
    });

    it('includes filter_clause in update and delete tool declarations and request bodies', async () => {
      const connectionUrl = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
      const routes: Record<string, unknown> = {
        [`${connectionUrl}?view=BASIC`]: {
          name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
          serviceDirectory: 'test-service',
        },
        [`${connectionUrl}/connectionSchemaMetadata:getEntityType?entityId=Issues`]:
          {name: 'operations/entity'},
        'https://connectors.googleapis.com/v1/operations/entity': {
          done: true,
          response: {
            jsonSchema: {
              type: 'object',
              properties: {summary: {type: 'string'}},
            },
            operations: ['UPDATE', 'DELETE'],
          },
        },
      };
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (!(url in routes)) {
          throw new Error(`No route for ${url}`);
        }
        return jsonResponse(routes[url]);
      });

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['UPDATE', 'DELETE']},
        toolNamePrefix: 'tracker',
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'tracker_update_issues',
        'tracker_delete_issues',
      ]);
      expect(
        Object.keys(tools[0]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual(['connector_input_payload', 'entity_id', 'filter_clause']);
      expect(
        Object.keys(tools[1]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual(['entity_id', 'filter_clause']);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({connectorOutputPayload: {}}));
      await tools[1].runAsync({
        args: {entity_id: 'issue-1', filter_clause: "status='closed'"},
        toolContext: toolContext(),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        operation: 'DELETE_ENTITY',
        entity: 'Issues',
        entityId: 'issue-1',
        filterClause: "status='closed'",
        connectionName: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: '',
      });
    });

    it('serializes dynamicAuthConfig in the connector request body when authOverrideEnabled is true', async () => {
      const connectionUrl = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
      const routes: Record<string, unknown> = {
        [`${connectionUrl}?view=BASIC`]: {
          name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
          serviceDirectory: 'test-service',
          authOverrideEnabled: true,
        },
        [`${connectionUrl}/connectionSchemaMetadata:getEntityType?entityId=Issues`]:
          {name: 'operations/entity'},
        'https://connectors.googleapis.com/v1/operations/entity': {
          done: true,
          response: {
            jsonSchema: {
              type: 'object',
              properties: {summary: {type: 'string'}},
            },
            operations: ['LIST'],
          },
        },
        [`${connectionUrl}/connectionSchemaMetadata:getAction?actionId=ExecuteCustomQuery`]:
          {name: 'operations/action'},
        'https://connectors.googleapis.com/v1/operations/action': {
          done: true,
          response: {
            inputJsonSchema: {type: 'object'},
            outputJsonSchema: {type: 'object'},
            displayName: 'ExecuteCustomQuery',
          },
        },
      };
      fetchMock.mockImplementation(async (input) => {
        const url = String(input);
        if (!(url in routes)) {
          throw new Error(`No route for ${url}`);
        }
        return jsonResponse(routes[url]);
      });
      vi.spyOn(
        ToolAuthHandler.prototype,
        'prepareAuthCredentials',
      ).mockResolvedValue({
        state: 'done',
        authCredential: TEST_AUTH_CREDENTIAL,
      });

      const tools = await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST']},
        actions: ['ExecuteCustomQuery'],
        toolNamePrefix: 'tracker',
        authScheme: TEST_AUTH_SCHEME,
        authCredential: TEST_AUTH_CREDENTIAL,
      }).getTools();

      expect(
        Object.keys(tools[0]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual(['filter_clause', 'page_size', 'page_token']);
      expect(
        Object.keys(tools[1]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual(['query', 'timeout', 'page_size']);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({connectorOutputPayload: []}));
      await tools[0].runAsync({
        args: {},
        toolContext: toolContext(),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        operation: 'LIST_ENTITIES',
        entity: 'Issues',
        connectionName: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: '',
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'dynamic_user_token',
        },
      });

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({connectorOutputPayload: []}));
      await tools[1].runAsync({
        args: {query: 'SELECT 1', timeout: 120, page_size: 50},
        toolContext: toolContext(),
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, queryInit] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(queryInit?.body))).toEqual({
        operation: 'EXECUTE_QUERY',
        action: 'ExecuteCustomQuery',
        query: 'SELECT 1',
        timeout: 120,
        pageSize: 50,
        connectionName: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
        serviceName: 'test-service',
        host: '',
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'dynamic_user_token',
        },
      });
    });
  });
});
