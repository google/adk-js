/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  ApplicationIntegrationToolsetOptions,
  AuthCredentialTypes,
  ConnectionsClient,
  CONNECTOR_BASE_SPEC,
  ConnectorSpec,
  Context,
  createSession,
  IntegrationClient,
  InvocationContext,
  listOperation,
  listOperationRequest,
  LlmAgent,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getAccessToken: vi.fn().mockResolvedValue('test_token'),
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({token: 'tool_token'}),
    }),
  })),
}));

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const CONNECTION = 'test-connection';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const VALIDATION_MESSAGE =
  'Either (integration and trigger) or (connection and (entityOperations or actions)) should be provided.';

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

function connectionInstructions(serviceName: string, host: string): string {
  return `ALWAYS use serviceName = ${serviceName}, host = ${host} and the connection name = projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION} when using this tool. DO NOT ask the user for these values as you already have those.`;
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
    trigger: 'test-trigger',
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
    it('adds the connection details to the instructions for entity operations', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
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

      await toolset({
        connection: CONNECTION,
        entityOperations: {Issues: ['LIST', 'GET']},
        toolName: 'My Connection Tool',
        toolInstructions: 'Use this tool to manage entities.',
      }).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith(
        'My Connection Tool',
        'Use this tool to manage entities.' +
          connectionInstructions('test-service', 'test.host'),
      );
      expect(integrationSpy).not.toHaveBeenCalled();
    });

    it('adds the connection details to the instructions for actions', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        serviceName: 'custom-service',
        host: 'custom.host',
        authOverrideEnabled: false,
      });
      const connectionSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForConnection')
        .mockResolvedValue(connectionSpec());

      await toolset({
        connection: CONNECTION,
        actions: ['create', 'delete'],
        toolName: 'My Actions Tool',
        toolInstructions: 'Use this tool.',
      }).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith(
        'My Actions Tool',
        'Use this tool.ALWAYS use serviceName = custom-service, host = custom.host and the connection name = projects/test-project/locations/us-central1/connections/test-connection when using this tool. DO NOT ask the user for these values as you already have those.',
      );
    });

    it('defaults the tool name and instructions to empty strings', async () => {
      vi.spyOn(
        ConnectionsClient.prototype,
        'getConnectionDetails',
      ).mockResolvedValue({
        serviceName: 'svc',
        host: '',
        authOverrideEnabled: false,
      });
      const connectionSpy = vi
        .spyOn(IntegrationClient.prototype, 'getOpenApiSpecForConnection')
        .mockResolvedValue(connectionSpec());

      await toolset({connection: CONNECTION, actions: ['a']}).getTools();

      expect(connectionSpy).toHaveBeenCalledExactlyOnceWith(
        '',
        connectionInstructions('svc', ''),
      );
    });
  });

  describe('validation', () => {
    it.each<[string, Partial<ApplicationIntegrationToolsetOptions>]>([
      ['nothing', {}],
      ['an integration without a trigger', {integration: 'test'}],
      ['a trigger without an integration', {trigger: 'test'}],
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
  });

  describe('with real clients', () => {
    it('turns a connector spec into one tool per operation', async () => {
      const connectionUrl = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
      const routes: Record<string, unknown> = {
        [`${connectionUrl}?view=BASIC`]: {serviceDirectory: 'test-service'},
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
        toolName: 'tracker',
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'tracker_list_issues',
        'tracker_execute_custom_query',
      ]);
      expect(tools[0].description).toContain(
        'Use this tool with entity = "Issues" and operation = "LIST_ENTITIES" only.',
      );
      expect(tools[0].description).toContain(
        connectionInstructions('test-service', ''),
      );

      expect(
        Object.keys(tools[0]._getDeclaration()?.parameters?.properties ?? {}),
      ).toEqual([
        'filter_clause',
        'page_size',
        'page_token',
        'operation',
        'connection_name',
        'service_name',
        'host',
        'entity',
      ]);
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({connectorOutputPayload: []}));
      await tools[0].runAsync({
        args: {
          operation: 'LIST_ENTITIES',
          entity: 'Issues',
          connection_name: `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`,
          service_name: 'test-service',
          host: '',
        },
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
  });
});
