/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  actionRequest,
  actionResponse,
  ConnectionsClient,
  CONNECTOR_BASE_SPEC,
  connectorPayload,
  createOperation,
  createOperationRequest,
  deleteOperation,
  deleteOperationRequest,
  executeCustomQueryRequest,
  getActionOperation,
  getOperation,
  getOperationRequest,
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
const CONNECTION = 'test-connection';
const CONNECTION_URL = `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
const OPERATION_URL = 'https://connectors.googleapis.com/v1/operations/test_op';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const INVALID_REQUEST_MESSAGE = `Invalid request. Please check the provided values of project(${PROJECT}), location(${LOCATION}), connection(${CONNECTION}).`;
const MISSING_CREDENTIALS_MESSAGE =
  'Please provide a service account that has the required permissions to access the connection.';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status});
}

function client(serviceAccountJson?: string): ConnectionsClient {
  return new ConnectionsClient({
    project: PROJECT,
    location: LOCATION,
    connection: CONNECTION,
    serviceAccountJson,
  });
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function ref(name: string) {
  return {$ref: `#/components/schemas/${name}`};
}

function postOperation(options: {
  summary: string;
  description: string;
  operationId: string;
  requestSchema: string;
  responseSchema: object;
}) {
  const {summary, description, operationId, requestSchema, responseSchema} =
    options;
  return {
    post: {
      summary,
      description,
      operationId,
      requestBody: {
        content: {'application/json': {schema: ref(requestSchema)}},
      },
      responses: {
        '200': {
          description: 'Success response',
          content: {'application/json': {schema: responseSchema}},
        },
      },
    },
  };
}

describe('ConnectionsClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mocks.getAccessToken.mockReset();
    mocks.getAccessToken.mockResolvedValue('test_token');
    vi.mocked(GoogleAuth).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('requests', () => {
    it('sends a GET with a bearer token and JSON content type', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await client().getConnectionDetails();

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${CONNECTION_URL}?view=BASIC`);
      expect(init).toEqual({
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test_token',
        },
        body: undefined,
      });
    });

    it.each([
      [404, 'Not Found'],
      [400, 'Bad Request'],
      [404, ''],
      [400, ''],
    ])(
      'reports HTTP %i %j as an invalid request',
      async (status, statusText) => {
        fetchMock.mockResolvedValue(
          new Response('', {status, statusText: statusText}),
        );

        await expect(client().getConnectionDetails()).rejects.toThrow(
          INVALID_REQUEST_MESSAGE,
        );
      },
    );

    it('reports any other HTTP error as a request error', async () => {
      fetchMock.mockResolvedValue(
        new Response('', {status: 500, statusText: 'Internal Server Error'}),
      );

      await expect(client().getConnectionDetails()).rejects.toThrow(
        `Request error: HTTP 500 Internal Server Error for url: ${CONNECTION_URL}?view=BASIC`,
      );
    });

    it('reports a failed fetch as a request error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client().getConnectionDetails()).rejects.toThrow(
        'Request error: fetch failed',
      );
    });

    it('reports a body that is not JSON as an unexpected error', async () => {
      fetchMock.mockResolvedValue(new Response('not json', {status: 200}));

      await expect(client().getConnectionDetails()).rejects.toThrow(
        /^An unexpected error occurred: /,
      );
    });

    it('reports a token failure as an unexpected error', async () => {
      mocks.getAccessToken.mockRejectedValue(new Error('Something went wrong'));
      const key = JSON.stringify({client_email: 'test@example.com'});

      await expect(client(key).getConnectionDetails()).rejects.toThrow(
        'An unexpected error occurred: Something went wrong',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getConnectionDetails', () => {
    it('uses the TLS service directory when the connection has a host', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          serviceDirectory: 'test_service',
          host: 'test.host',
          tlsServiceDirectory: 'tls_test_service',
          authOverrideEnabled: true,
        }),
      );

      await expect(client().getConnectionDetails()).resolves.toEqual({
        serviceName: 'tls_test_service',
        host: 'test.host',
        authOverrideEnabled: true,
      });
    });

    it('uses the service directory when the connection has no host', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          serviceDirectory: 'test_service',
          authOverrideEnabled: false,
        }),
      );

      await expect(client().getConnectionDetails()).resolves.toEqual({
        serviceName: 'test_service',
        host: '',
        authOverrideEnabled: false,
      });
    });

    it('defaults every missing field', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await expect(client().getConnectionDetails()).resolves.toEqual({
        serviceName: '',
        host: '',
        authOverrideEnabled: false,
      });
    });

    it('propagates a request error', async () => {
      fetchMock.mockResolvedValue(new Response('', {status: 503}));

      await expect(client().getConnectionDetails()).rejects.toThrow(
        'Request error',
      );
    });
  });

  describe('getEntitySchemaAndOperations', () => {
    it('polls the operation and returns the schema and operations', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({name: 'operations/test_op'}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              jsonSchema: {type: 'object'},
              operations: ['LIST', 'GET'],
            },
          }),
        );

      await expect(
        client().getEntitySchemaAndOperations('entity1'),
      ).resolves.toEqual({
        schema: {type: 'object'},
        operations: ['LIST', 'GET'],
      });
      expect(requestedUrls()).toEqual([
        `${CONNECTION_URL}/connectionSchemaMetadata:getEntityType?entityId=entity1`,
        OPERATION_URL,
      ]);
    });

    it('waits between polls until the operation is done', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({name: 'operations/test_op'}))
        .mockResolvedValueOnce(jsonResponse({done: false}))
        .mockResolvedValueOnce(
          jsonResponse({done: true, response: {operations: ['LIST']}}),
        );

      const result = client().getEntitySchemaAndOperations('entity1');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toEqual({schema: {}, operations: ['LIST']});
      expect(requestedUrls()).toEqual([
        `${CONNECTION_URL}/connectionSchemaMetadata:getEntityType?entityId=entity1`,
        OPERATION_URL,
        OPERATION_URL,
      ]);
    });

    it('throws when the API starts no operation', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await expect(
        client().getEntitySchemaAndOperations('entity1'),
      ).rejects.toThrow(
        'Failed to get entity schema and operations for entity: entity1',
      );
    });

    it('propagates a request error', async () => {
      fetchMock.mockResolvedValue(new Response('', {status: 503}));

      await expect(
        client().getEntitySchemaAndOperations('entity1'),
      ).rejects.toThrow('Request error');
    });
  });

  describe('getActionSchema', () => {
    it('polls the operation and returns the action schema', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({name: 'operations/test_op'}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              inputJsonSchema: {
                type: 'object',
                properties: {input: {type: 'string'}},
              },
              outputJsonSchema: {
                type: 'object',
                properties: {output: {type: 'string'}},
              },
              description: 'Test Action Description',
              displayName: 'TestAction',
            },
          }),
        );

      await expect(client().getActionSchema('action1')).resolves.toEqual({
        inputSchema: {type: 'object', properties: {input: {type: 'string'}}},
        outputSchema: {type: 'object', properties: {output: {type: 'string'}}},
        description: 'Test Action Description',
        displayName: 'TestAction',
      });
      expect(requestedUrls()).toEqual([
        `${CONNECTION_URL}/connectionSchemaMetadata:getAction?actionId=action1`,
        OPERATION_URL,
      ]);
    });

    it('defaults every missing field', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({name: 'operations/test_op'}))
        .mockResolvedValueOnce(jsonResponse({done: true}));

      await expect(client().getActionSchema('action1')).resolves.toEqual({
        inputSchema: {},
        outputSchema: {},
        description: '',
        displayName: '',
      });
    });

    it('throws when the API starts no operation', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await expect(client().getActionSchema('action1')).rejects.toThrow(
        'Failed to get action schema for action: action1',
      );
    });

    it('propagates a request error', async () => {
      fetchMock.mockResolvedValue(new Response('', {status: 503}));

      await expect(client().getActionSchema('action1')).rejects.toThrow(
        'Request error',
      );
    });
  });

  describe('spec builders', () => {
    it('defines the base spec', () => {
      expect(CONNECTOR_BASE_SPEC).toEqual({
        openapi: '3.0.1',
        info: {
          title: 'ExecuteConnection',
          description: 'This tool can execute a query on connection',
          version: '4',
        },
        servers: [{url: 'https://integrations.googleapis.com'}],
        security: [{google_auth: [CLOUD_PLATFORM_SCOPE]}],
        paths: {},
        components: {
          schemas: {
            operation: {
              type: 'string',
              default: 'LIST_ENTITIES',
              description:
                'Operation to execute. Possible values are LIST_ENTITIES, GET_ENTITY, CREATE_ENTITY, UPDATE_ENTITY, DELETE_ENTITY in case of entities. EXECUTE_ACTION in case of actions. and EXECUTE_QUERY in case of custom queries.',
            },
            entityId: {type: 'string', description: 'Name of the entity'},
            connectorInputPayload: {type: 'object'},
            filterClause: {
              type: 'string',
              default: '',
              description: 'WHERE clause in SQL query',
            },
            pageSize: {
              type: 'integer',
              default: 50,
              description: 'Number of entities to return in the response',
            },
            pageToken: {
              type: 'string',
              default: '',
              description: 'Page token to return the next page of entities',
            },
            connectionName: {
              type: 'string',
              default: '',
              description: 'Connection resource name to run the query for',
            },
            serviceName: {
              type: 'string',
              default: '',
              description: 'Service directory for the connection',
            },
            host: {
              type: 'string',
              default: '',
              description: 'Host name in case of tls service directory',
            },
            entity: {
              type: 'string',
              default: 'Issues',
              description: 'Entity to run the query for',
            },
            action: {
              type: 'string',
              default: 'ExecuteCustomQuery',
              description: 'Action to run the query for',
            },
            query: {
              type: 'string',
              default: '',
              description: 'Custom Query to execute on the connection',
            },
            dynamicAuthConfig: {
              type: 'object',
              default: {},
              description: 'Dynamic auth config for the connection',
            },
            timeout: {
              type: 'integer',
              default: 120,
              description: 'Timeout in seconds for execution of custom query',
            },
            connectorOutputPayload: {type: 'object'},
            nextPageToken: {type: 'string'},
            'execute-connector_Response': {
              required: ['connectorOutputPayload'],
              type: 'object',
              properties: {
                connectorOutputPayload: ref('connectorOutputPayload'),
                nextPageToken: ref('nextPageToken'),
              },
            },
          },
          securitySchemes: {
            google_auth: {
              type: 'oauth2',
              flows: {
                implicit: {
                  authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
                  scopes: {
                    [CLOUD_PLATFORM_SCOPE]: 'Auth for google cloud services',
                  },
                },
              },
            },
          },
        },
      });
    });

    it('builds an action operation', () => {
      expect(
        getActionOperation({
          action: 'TestAction',
          operation: 'EXECUTE_ACTION',
          actionDisplayName: 'TestActionDisplayName',
          toolName: 'test_tool',
          toolInstructions: 'Extra.',
        }),
      ).toEqual(
        postOperation({
          summary: 'TestActionDisplayName',
          description:
            'Use this tool with action = "TestAction" and operation = "EXECUTE_ACTION" only. Don\'t ask these values from user. Extra.',
          operationId: 'test_tool_TestActionDisplayName',
          requestSchema: 'TestActionDisplayName_Request',
          responseSchema: ref('TestActionDisplayName_Response'),
        }),
      );
    });

    it('adds query guidance to a custom query operation', () => {
      expect(
        getActionOperation({
          action: 'ExecuteCustomQuery',
          operation: 'EXECUTE_QUERY',
          actionDisplayName: 'Execute Custom Query',
        }),
      ).toEqual(
        postOperation({
          summary: 'Execute Custom Query',
          description:
            'Use this tool with action = "ExecuteCustomQuery" and operation = "EXECUTE_QUERY" only. Don\'t ask these values from user. Use pageSize = 50 and timeout = 120 until user specifies a different value otherwise. If user provides a query in natural language, convert it to SQL query and then execute it using the tool. ',
          operationId: '_Execute Custom Query',
          requestSchema: 'Execute Custom Query_Request',
          responseSchema: ref('Execute Custom Query_Response'),
        }),
      );
    });

    it('builds a list operation', () => {
      expect(
        listOperation({
          entity: 'Entity1',
          schemaAsString: '{"type": "object"}',
          toolName: 'test_tool',
          toolInstructions: 'Extra.',
        }),
      ).toEqual(
        postOperation({
          summary: 'List Entity1',
          description:
            'Returns all entities of type Entity1. Use this tool with entity = "Entity1" and operation = "LIST_ENTITIES" only. Don\'t ask these values from user. Always use "" as filter clause and "" as page token and 50 as page size until user specifies a different value otherwise. Use single quotes for strings in filter clause. Extra.',
          operationId: 'test_tool_list_Entity1',
          requestSchema: 'list_Entity1_Request',
          responseSchema: {
            description:
              'Returns a list of Entity1 of json schema: {"type": "object"}',
            $ref: '#/components/schemas/execute-connector_Response',
          },
        }),
      );
    });

    it('builds a get operation', () => {
      expect(
        getOperation({
          entity: 'Entity1',
          schemaAsString: '{"type": "object"}',
          toolName: 'test_tool',
        }),
      ).toEqual(
        postOperation({
          summary: 'Get Entity1',
          description:
            'Returns the details of the Entity1. Use this tool with entity = "Entity1" and operation = "GET_ENTITY" only. Don\'t ask these values from user.  ',
          operationId: 'test_tool_get_Entity1',
          requestSchema: 'get_Entity1_Request',
          responseSchema: {
            description: 'Returns Entity1 of json schema: {"type": "object"}',
            $ref: '#/components/schemas/execute-connector_Response',
          },
        }),
      );
    });

    it('builds a create operation', () => {
      expect(
        createOperation({
          entity: 'Entity1',
          toolName: 'test_tool',
          toolInstructions: 'Extra.',
        }),
      ).toEqual(
        postOperation({
          summary: 'Create Entity1',
          description:
            'Creates a new entity of type Entity1. Use this tool with entity = "Entity1" and operation = "CREATE_ENTITY" only. Don\'t ask these values from user. Follow the schema of the entity provided in the instructions to create Entity1.  Extra.',
          operationId: 'test_tool_create_Entity1',
          requestSchema: 'create_Entity1_Request',
          responseSchema: ref('execute-connector_Response'),
        }),
      );
    });

    it('builds an update operation', () => {
      expect(
        updateOperation({entity: 'Entity1', toolName: 'test_tool'}),
      ).toEqual(
        postOperation({
          summary: 'Update Entity1',
          description:
            'Updates an entity of type Entity1. Use this tool with entity = "Entity1" and operation = "UPDATE_ENTITY" only. Don\'t ask these values from user. Use entityId to uniquely identify the entity to update. Follow the schema of the entity provided in the instructions to update Entity1.  ',
          operationId: 'test_tool_update_Entity1',
          requestSchema: 'update_Entity1_Request',
          responseSchema: ref('execute-connector_Response'),
        }),
      );
    });

    it('builds a delete operation', () => {
      expect(
        deleteOperation({entity: 'Entity1', toolName: 'test_tool'}),
      ).toEqual(
        postOperation({
          summary: 'Delete Entity1',
          description:
            'Deletes an entity of type Entity1. Use this tool with entity = "Entity1" and operation = "DELETE_ENTITY" only. Don\'t ask these values from user.  ',
          operationId: 'test_tool_delete_Entity1',
          requestSchema: 'delete_Entity1_Request',
          responseSchema: ref('execute-connector_Response'),
        }),
      );
    });

    it('defaults the tool name and instructions to empty strings', () => {
      const operation = deleteOperation({entity: 'Entity1'});

      expect(operation).toEqual(
        postOperation({
          summary: 'Delete Entity1',
          description:
            'Deletes an entity of type Entity1. Use this tool with entity = "Entity1" and operation = "DELETE_ENTITY" only. Don\'t ask these values from user.  ',
          operationId: '_delete_Entity1',
          requestSchema: 'delete_Entity1_Request',
          responseSchema: ref('execute-connector_Response'),
        }),
      );
    });

    it('builds the create request schema', () => {
      expect(createOperationRequest('Entity1')).toEqual({
        type: 'object',
        required: [
          'connectorInputPayload',
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'entity',
        ],
        properties: {
          connectorInputPayload: ref('connectorInputPayload_Entity1'),
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          entity: ref('entity'),
        },
      });
    });

    it('builds the update request schema', () => {
      expect(updateOperationRequest('Entity1')).toEqual({
        type: 'object',
        required: [
          'connectorInputPayload',
          'entityId',
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'entity',
        ],
        properties: {
          connectorInputPayload: ref('connectorInputPayload_Entity1'),
          entityId: ref('entityId'),
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          entity: ref('entity'),
        },
      });
    });

    it('builds the get and delete request schemas', () => {
      const expected = {
        type: 'object',
        required: [
          'entityId',
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'entity',
        ],
        properties: {
          entityId: ref('entityId'),
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          entity: ref('entity'),
        },
      };

      expect(getOperationRequest()).toEqual(expected);
      expect(deleteOperationRequest()).toEqual(expected);
    });

    it('builds the list request schema', () => {
      expect(listOperationRequest()).toEqual({
        type: 'object',
        required: [
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'entity',
        ],
        properties: {
          filterClause: ref('filterClause'),
          pageSize: ref('pageSize'),
          pageToken: ref('pageToken'),
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          entity: ref('entity'),
        },
      });
    });

    it('builds the action request schema', () => {
      expect(actionRequest('TestAction')).toEqual({
        type: 'object',
        required: [
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'action',
          'connectorInputPayload',
        ],
        properties: {
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          action: ref('action'),
          connectorInputPayload: ref('connectorInputPayload_TestAction'),
        },
      });
    });

    it('builds the action response schema', () => {
      expect(actionResponse('TestAction')).toEqual({
        type: 'object',
        properties: {
          connectorOutputPayload: ref('connectorOutputPayload_TestAction'),
        },
      });
    });

    it('builds the custom query request schema', () => {
      expect(executeCustomQueryRequest()).toEqual({
        type: 'object',
        required: [
          'operation',
          'connectionName',
          'serviceName',
          'host',
          'action',
          'query',
          'timeout',
          'pageSize',
        ],
        properties: {
          operation: ref('operation'),
          connectionName: ref('connectionName'),
          serviceName: ref('serviceName'),
          host: ref('host'),
          action: ref('action'),
          query: ref('query'),
          timeout: ref('timeout'),
          pageSize: ref('pageSize'),
        },
      });
    });
  });

  describe('connectorPayload', () => {
    it('maps a nullable type and keeps the description', () => {
      expect(
        connectorPayload({
          type: 'object',
          properties: {
            input: {type: ['null', 'string'], description: 'description'},
          },
        }),
      ).toEqual({
        type: 'object',
        properties: {
          input: {type: 'string', nullable: true, description: 'description'},
        },
      });
    });

    it('takes the first type of a type list without null', () => {
      expect(connectorPayload({type: ['integer', 'string']})).toEqual({
        type: 'integer',
      });
    });

    it('marks a null-only type as nullable with no type', () => {
      expect(connectorPayload({type: ['null']})).toEqual({
        nullable: true,
      });
    });

    it('converts nested properties and drops other keywords', () => {
      expect(
        connectorPayload({
          type: 'object',
          required: ['outer'],
          properties: {
            outer: {
              type: 'object',
              properties: {inner: {type: ['string', 'null'], format: 'date'}},
            },
          },
        }),
      ).toEqual({
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: {inner: {type: 'string', nullable: true}},
          },
        },
      });
    });

    it('converts a single items schema', () => {
      expect(
        connectorPayload({
          type: 'array',
          items: {type: ['null', 'number'], description: 'value'},
        }),
      ).toEqual({
        type: 'array',
        items: {type: 'number', nullable: true, description: 'value'},
      });
    });

    it('converts a list of items schemas', () => {
      expect(
        connectorPayload({
          type: 'array',
          items: [{type: 'string'}, {type: ['null', 'integer']}],
        }),
      ).toEqual({
        type: 'array',
        items: [{type: 'string'}, {type: 'integer', nullable: true}],
      });
    });

    it('ignores properties on a schema that is not an object', () => {
      expect(
        client().connectorPayload({
          type: 'string',
          properties: {a: {type: 'string'}},
        }),
      ).toEqual({type: 'string'});
    });
  });

  describe('access tokens', () => {
    it('reuses one GoogleAuth across requests', async () => {
      fetchMock.mockImplementation(async () => jsonResponse({}));
      const connectionsClient = client();

      await connectionsClient.getConnectionDetails();
      await connectionsClient.getConnectionDetails();

      expect(GoogleAuth).toHaveBeenCalledOnce();
      expect(mocks.getAccessToken).toHaveBeenCalledTimes(2);
    });

    it('passes a service-account key as credentials', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const key = {client_email: 'test@example.com', private_key: 'test_key'};
      mocks.getAccessToken.mockResolvedValue('sa_token');

      await client(JSON.stringify(key)).getConnectionDetails();

      expect(GoogleAuth).toHaveBeenCalledWith({
        scopes: [CLOUD_PLATFORM_SCOPE],
        credentials: key,
      });
      expect(
        new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization'),
      ).toBe('Bearer sa_token');
    });

    it('uses Application Default Credentials without a key', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      await client().getConnectionDetails();

      expect(GoogleAuth).toHaveBeenCalledWith({scopes: [CLOUD_PLATFORM_SCOPE]});
    });

    it('reports unavailable default credentials', async () => {
      mocks.getAccessToken.mockRejectedValue(
        new Error('Could not load the default credentials.'),
      );

      await expect(client().getConnectionDetails()).rejects.toThrow(
        `An unexpected error occurred: ${MISSING_CREDENTIALS_MESSAGE}`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a credential that issues no token', async () => {
      mocks.getAccessToken.mockResolvedValue(null);

      await expect(client().getConnectionDetails()).rejects.toThrow(
        `An unexpected error occurred: ${MISSING_CREDENTIALS_MESSAGE}`,
      );
    });
  });
});
