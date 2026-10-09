/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  actionRequest,
  actionResponse,
  CONNECTOR_BASE_SPEC,
  createOperation,
  createOperationRequest,
  deleteOperation,
  deleteOperationRequest,
  executeCustomQueryRequest,
  getActionOperation,
  getOperation,
  getOperationRequest,
  IntegrationClient,
  listOperation,
  listOperationRequest,
  updateOperation,
  updateOperationRequest,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn<() => Promise<string | null | undefined>>(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({getAccessToken: mocks.getAccessToken})),
}));

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const INTEGRATION = 'test-integration';
const TRIGGER = 'test-trigger';
const CONNECTION = 'test-connection';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GENERATE_SPEC_URL = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}:generateOpenApiSpec`;
const CONNECTION_URL = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
const PATH_PREFIX = `/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection`;
const MISSING_CREDENTIALS_MESSAGE =
  'Please provide a service account that has the required permissions to access the connection.';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

/** Answers each request with the body registered for its URL. */
function routeFetch(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (!(url in routes)) {
      throw new Error(`No route for ${url}`);
    }
    return jsonResponse(routes[url]);
  });
}

function entityRoutes(options: {
  entity: string;
  jsonSchema: object;
  operations: string[];
}): Record<string, unknown> {
  const {entity, jsonSchema, operations} = options;
  return {
    [`${CONNECTION_URL}/connectionSchemaMetadata:getEntityType?entityId=${entity}`]:
      {name: `operations/entity_${entity}`},
    [`https://connectors.googleapis.com/v1/operations/entity_${entity}`]: {
      done: true,
      response: {jsonSchema, operations},
    },
  };
}

function actionRoutes(
  action: string,
  response: object,
): Record<string, unknown> {
  return {
    [`${CONNECTION_URL}/connectionSchemaMetadata:getAction?actionId=${action}`]:
      {name: `operations/action_${action}`},
    [`https://connectors.googleapis.com/v1/operations/action_${action}`]: {
      done: true,
      response,
    },
  };
}

function integrationClient(serviceAccountJson?: string): IntegrationClient {
  return new IntegrationClient({
    project: PROJECT,
    location: LOCATION,
    integration: INTEGRATION,
    trigger: TRIGGER,
    serviceAccountJson,
  });
}

function connectionClient(
  entityOperations?: Record<string, string[]>,
  actions?: string[],
): IntegrationClient {
  return new IntegrationClient({
    project: PROJECT,
    location: LOCATION,
    connection: CONNECTION,
    entityOperations,
    actions,
  });
}

describe('IntegrationClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getAccessToken.mockReset();
    mocks.getAccessToken.mockResolvedValue('test_token');
    vi.mocked(GoogleAuth).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getOpenApiSpecForIntegration', () => {
    it('posts the trigger and parses the returned spec', async () => {
      const expectedSpec = {
        openapi: '3.0.0',
        info: {title: 'Test Integration'},
      };
      fetchMock.mockResolvedValue(
        jsonResponse({openApiSpec: JSON.stringify(expectedSpec)}),
      );

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).resolves.toEqual(expectedSpec);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(GENERATE_SPEC_URL);
      expect(init).toEqual({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test_token',
        },
        body: JSON.stringify({
          apiTriggerResources: [
            {integrationResource: INTEGRATION, triggerId: [TRIGGER]},
          ],
          fileFormat: 'JSON',
        }),
      });
    });

    it('reports a missing credential as an unexpected error', async () => {
      mocks.getAccessToken.mockRejectedValue(new Error('no credentials'));

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        `An unexpected error occurred: ${MISSING_CREDENTIALS_MESSAGE}`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      [404, 'Not Found'],
      [400, 'Bad Request'],
      [404, ''],
      [400, ''],
    ])(
      'reports HTTP %i %j as an invalid request',
      async (status, statusText) => {
        fetchMock.mockResolvedValue(new Response('', {status, statusText}));

        await expect(
          integrationClient().getOpenApiSpecForIntegration(),
        ).rejects.toThrow(
          `Invalid request. Please check the provided values of project(${PROJECT}), location(${LOCATION}), integration(${INTEGRATION}) and trigger(${TRIGGER}).`,
        );
      },
    );

    it('reports any other HTTP error as a request error', async () => {
      fetchMock.mockResolvedValue(
        new Response('', {status: 500, statusText: 'Internal Server Error'}),
      );

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        `Request error: HTTP 500 Internal Server Error for url: ${GENERATE_SPEC_URL}`,
      );
    });

    it('reports a failed fetch as a request error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Something went wrong'));

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow('Request error: Something went wrong');
    });

    it('reports a response without a spec as an unexpected error', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'An unexpected error occurred: The response carries no openApiSpec string.',
      );
    });

    it('reports a spec that is not JSON as an unexpected error', async () => {
      fetchMock.mockResolvedValue(jsonResponse({openApiSpec: 'not json'}));

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow(/^An unexpected error occurred: /);
    });
  });

  describe('getOpenApiSpecForConnection', () => {
    it('throws before any request when nothing is configured', async () => {
      await expect(
        connectionClient().getOpenApiSpecForConnection(),
      ).rejects.toThrow(
        'No entity operations or actions provided. Please provide at least one of them.',
      );
      await expect(
        connectionClient({}, []).getOpenApiSpecForConnection(),
      ).rejects.toThrow('No entity operations or actions provided.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('adds a path and a request schema per entity operation', async () => {
      const entitySchema = {type: 'object', properties: {id: {type: 'string'}}};
      routeFetch(
        entityRoutes({
          entity: 'entity1',
          jsonSchema: entitySchema,
          operations: ['LIST', 'GET'],
        }),
      );
      const schemaAsString = JSON.stringify(entitySchema);

      const spec = await connectionClient({
        entity1: ['LIST', 'get'],
      }).getOpenApiSpecForConnection('tool', 'Extra.');

      expect(spec.paths).toEqual({
        [`${PATH_PREFIX}#list_entity1`]: listOperation({
          entity: 'entity1',
          schemaAsString,
          toolName: 'tool',
          toolInstructions: 'Extra.',
        }),
        [`${PATH_PREFIX}#get_entity1`]: getOperation({
          entity: 'entity1',
          schemaAsString,
          toolName: 'tool',
          toolInstructions: 'Extra.',
        }),
      });
      const baseSchemas = CONNECTOR_BASE_SPEC.components.schemas;
      expect(spec.components.schemas).toEqual({
        ...baseSchemas,
        connectorInputPayload_entity1: {
          type: 'object',
          properties: {id: {type: 'string'}},
        },
        list_entity1_Request: listOperationRequest(),
        get_entity1_Request: getOperationRequest(),
      });
      expect(CONNECTOR_BASE_SPEC.paths).toEqual({});
    });

    it('covers create, update and delete', async () => {
      routeFetch(
        entityRoutes({entity: 'entity1', jsonSchema: {}, operations: []}),
      );

      const spec = await connectionClient({
        entity1: ['CREATE', 'UPDATE', 'DELETE'],
      }).getOpenApiSpecForConnection();

      expect(spec.paths).toEqual({
        [`${PATH_PREFIX}#create_entity1`]: createOperation({entity: 'entity1'}),
        [`${PATH_PREFIX}#update_entity1`]: updateOperation({entity: 'entity1'}),
        [`${PATH_PREFIX}#delete_entity1`]: deleteOperation({entity: 'entity1'}),
      });
      expect(spec.components.schemas['create_entity1_Request']).toEqual(
        createOperationRequest('entity1'),
      );
      expect(spec.components.schemas['update_entity1_Request']).toEqual(
        updateOperationRequest('entity1'),
      );
      expect(spec.components.schemas['delete_entity1_Request']).toEqual(
        deleteOperationRequest(),
      );
    });

    it('uses the supported operations when the list is empty', async () => {
      routeFetch(
        entityRoutes({
          entity: 'entity1',
          jsonSchema: {},
          operations: ['LIST', 'GET'],
        }),
      );

      const spec = await connectionClient({
        entity1: [],
      }).getOpenApiSpecForConnection();

      expect(Object.keys(spec.paths)).toEqual([
        `${PATH_PREFIX}#list_entity1`,
        `${PATH_PREFIX}#get_entity1`,
      ]);
    });

    it('adds the schemas and path of an action', async () => {
      routeFetch(
        actionRoutes('TestAction', {
          inputJsonSchema: {
            type: 'object',
            properties: {input: {type: 'string'}},
          },
          outputJsonSchema: {
            type: 'object',
            properties: {output: {type: ['null', 'string']}},
          },
          displayName: 'Test Action',
        }),
      );

      const spec = await connectionClient(undefined, [
        'TestAction',
      ]).getOpenApiSpecForConnection('tool', 'Extra.');

      expect(spec.paths).toEqual({
        [`${PATH_PREFIX}#TestAction`]: getActionOperation({
          action: 'TestAction',
          operation: 'EXECUTE_ACTION',
          actionDisplayName: 'Test Action',
          toolName: 'tool',
          toolInstructions: 'Extra.',
        }),
      });
      const baseSchemas = CONNECTOR_BASE_SPEC.components.schemas;
      expect(spec.components.schemas).toEqual({
        ...baseSchemas,
        'Test Action_Request': actionRequest('Test Action'),
        'connectorInputPayload_Test Action': {
          type: 'object',
          properties: {input: {type: 'string'}},
        },
        'connectorOutputPayload_Test Action': {
          type: 'object',
          properties: {output: {type: 'string', nullable: true}},
        },
        'Test Action_Response': actionResponse('Test Action'),
      });
    });

    it('runs ExecuteCustomQuery as a query rather than an action', async () => {
      routeFetch(
        actionRoutes('ExecuteCustomQuery', {
          inputJsonSchema: {type: 'object'},
          outputJsonSchema: {type: 'object'},
          displayName: 'Execute Custom Query',
        }),
      );

      const spec = await connectionClient(undefined, [
        'ExecuteCustomQuery',
      ]).getOpenApiSpecForConnection();

      expect(spec.paths).toEqual({
        [`${PATH_PREFIX}#ExecuteCustomQuery`]: getActionOperation({
          action: 'ExecuteCustomQuery',
          operation: 'EXECUTE_QUERY',
          actionDisplayName: 'Execute Custom Query',
        }),
      });
      const baseSchemas = CONNECTOR_BASE_SPEC.components.schemas;
      expect(spec.components.schemas).toEqual({
        ...baseSchemas,
        ExecuteCustomQuery_Request: executeCustomQueryRequest(),
        'connectorOutputPayload_Execute Custom Query': {type: 'object'},
        'Execute Custom Query_Response': actionResponse('Execute Custom Query'),
      });
    });

    it('throws for an unknown operation', async () => {
      routeFetch(
        entityRoutes({
          entity: 'entity1',
          jsonSchema: {},
          operations: ['LIST', 'GET'],
        }),
      );

      await expect(
        connectionClient({entity1: ['INVALID']}).getOpenApiSpecForConnection(),
      ).rejects.toThrow('Invalid operation: INVALID for entity: entity1');
    });
  });

  describe('access tokens', () => {
    it('reuses one GoogleAuth across requests', async () => {
      fetchMock.mockImplementation(async () =>
        jsonResponse({openApiSpec: '{}'}),
      );
      const client = integrationClient();

      await client.getOpenApiSpecForIntegration();
      await client.getOpenApiSpecForIntegration();

      expect(GoogleAuth).toHaveBeenCalledOnce();
      expect(mocks.getAccessToken).toHaveBeenCalledTimes(2);
    });

    it('passes a service-account key as credentials', async () => {
      fetchMock.mockResolvedValue(jsonResponse({openApiSpec: '{}'}));
      const key = {client_email: 'test@example.com', private_key: 'test_key'};

      await integrationClient(
        JSON.stringify(key),
      ).getOpenApiSpecForIntegration();

      expect(GoogleAuth).toHaveBeenCalledWith({
        scopes: [CLOUD_PLATFORM_SCOPE],
        credentials: key,
      });
    });

    it('uses Application Default Credentials without a key', async () => {
      fetchMock.mockResolvedValue(jsonResponse({openApiSpec: '{}'}));

      await integrationClient().getOpenApiSpecForIntegration();

      expect(GoogleAuth).toHaveBeenCalledWith({scopes: [CLOUD_PLATFORM_SCOPE]});
    });

    it('reports a credential that issues no token', async () => {
      mocks.getAccessToken.mockResolvedValue(undefined);

      await expect(
        integrationClient().getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        `An unexpected error occurred: ${MISSING_CREDENTIALS_MESSAGE}`,
      );
    });
  });
});
