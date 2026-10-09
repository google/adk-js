/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';
import {JsonObject, toJsonObject} from '../../../utils/json_utils.js';
import {CloudPlatformTokenSource, sendCloudRequest} from './cloud_request.js';

/** Base URL of the Integration Connectors API. */
const CONNECTOR_URL = 'https://connectors.googleapis.com';

/** Wait between two polls of a long-running operation, in milliseconds. */
const OPERATION_POLL_INTERVAL_MS = 1000;

/** Options for {@link ConnectionsClient}. */
export interface ConnectionsClientOptions {
  /** The Google Cloud project ID. */
  project: string;
  /** The Google Cloud location, such as `us-central1`. */
  location: string;
  /** The connection name. */
  connection: string;
  /**
   * A service-account key, as a JSON string. When omitted, requests use
   * Application Default Credentials.
   */
  serviceAccountJson?: string;
}

/** Service details of an Integration Connectors connection. */
export interface ConnectionDetails {
  /**
   * The Service Directory name of the connection. For a connection with a
   * `host`, the TLS Service Directory name.
   */
  serviceName: string;
  /** The host of the connection, or `''` when it has none. */
  host: string;
  /** Whether the connection lets a request override its authentication. */
  authOverrideEnabled: boolean;
}

/** The schema of one entity of a connection, and the operations it supports. */
export interface EntitySchemaAndOperations {
  /** The JSON schema of the entity. */
  schema: JsonObject;
  /** The operations the entity supports, such as `LIST` or `GET`. */
  operations: string[];
}

/** The input and output schemas of one action of a connection. */
export interface ActionSchema {
  /** The JSON schema of the action input. */
  inputSchema: JsonObject;
  /** The JSON schema of the action output. */
  outputSchema: JsonObject;
  /** The description of the action. */
  description: string;
  /** The display name of the action. */
  displayName: string;
}

/** The OpenAPI document of the `ExecuteConnection` integration. */
export interface ConnectorSpec {
  openapi: string;
  info: {title: string; description: string; version: string};
  servers: Array<{url: string}>;
  security: Array<Record<string, string[]>>;
  /** Path items, keyed by path. */
  paths: Record<string, JsonObject>;
  components: {
    /** Schemas, keyed by name. */
    schemas: Record<string, JsonObject>;
    securitySchemes: Record<string, OpenAPIV3.SecuritySchemeObject>;
  };
}

/** Options for {@link getActionOperation}. */
export interface GetActionOperationOptions {
  /** The action name. */
  action: string;
  /** `EXECUTE_ACTION`, or `EXECUTE_QUERY` for a custom query. */
  operation: string;
  /** The display name of the action. */
  actionDisplayName: string;
  /** Prefix of the generated `operationId`. Defaults to `''`. */
  toolName?: string;
  /** Text appended to the description. Defaults to `''`. */
  toolInstructions?: string;
}

/** Options for {@link listOperation} and {@link getOperation}. */
export interface EntitySchemaOperationOptions {
  /** The entity name. */
  entity: string;
  /**
   * The entity JSON schema, quoted in the response description. Defaults to
   * `''`.
   */
  schemaAsString?: string;
  /** Prefix of the generated `operationId`. Defaults to `''`. */
  toolName?: string;
  /** Text appended to the description. Defaults to `''`. */
  toolInstructions?: string;
}

/**
 * Options for {@link createOperation}, {@link updateOperation} and
 * {@link deleteOperation}.
 */
export interface EntityOperationOptions {
  /** The entity name. */
  entity: string;
  /** Prefix of the generated `operationId`. Defaults to `''`. */
  toolName?: string;
  /** Text appended to the description. Defaults to `''`. */
  toolInstructions?: string;
}

interface PostOperationOptions {
  summary: string;
  description: string;
  operationId: string;
  requestSchemaRef: string;
  responseSchema: JsonObject;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schemaRef(name: string): {$ref: string} {
  return {$ref: `#/components/schemas/${name}`};
}

/** The base OpenAPI document of the `ExecuteConnection` integration. */
export const CONNECTOR_BASE_SPEC: ConnectorSpec = {
  openapi: '3.0.1',
  info: {
    title: 'ExecuteConnection',
    description: 'This tool can execute a query on connection',
    version: '4',
  },
  servers: [{url: 'https://integrations.googleapis.com'}],
  security: [{google_auth: ['https://www.googleapis.com/auth/cloud-platform']}],
  paths: {},
  components: {
    schemas: {
      operation: {
        type: 'string',
        default: 'LIST_ENTITIES',
        description:
          'Operation to execute. Possible values are LIST_ENTITIES, GET_ENTITY, CREATE_ENTITY, UPDATE_ENTITY, DELETE_ENTITY in case of entities. EXECUTE_ACTION in case of actions. and EXECUTE_QUERY in case of custom queries.',
      },
      entityId: {
        type: 'string',
        description: 'Name of the entity',
      },
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
          connectorOutputPayload: schemaRef('connectorOutputPayload'),
          nextPageToken: schemaRef('nextPageToken'),
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
              'https://www.googleapis.com/auth/cloud-platform':
                'Auth for google cloud services',
            },
          },
        },
      },
    },
  },
};

/**
 * Converts the JSON schema of an entity or an action payload into the
 * OpenAPI schema the connector spec carries.
 *
 * Keeps `description`, maps a `type` array holding `null` to `nullable: true`
 * plus the first other type, and recurses into `properties` of an object and
 * `items` of an array. Every other keyword is dropped.
 *
 * @param jsonSchema The JSON schema.
 * @returns The OpenAPI schema.
 */
export function connectorPayload(jsonSchema: JsonObject): JsonObject {
  const openApiSchema: JsonObject = {};

  if ('description' in jsonSchema) {
    openApiSchema['description'] = jsonSchema['description'];
  }

  if ('type' in jsonSchema) {
    const type = jsonSchema['type'];
    if (Array.isArray(type)) {
      if (type.includes('null')) {
        openApiSchema['nullable'] = true;
        const otherTypes = type.filter((t) => t !== 'null');
        if (otherTypes.length > 0) {
          openApiSchema['type'] = otherTypes[0];
        }
      } else if (type.length > 0) {
        openApiSchema['type'] = type[0];
      }
    } else {
      openApiSchema['type'] = type;
    }
  }

  if (openApiSchema['type'] === 'object' && 'properties' in jsonSchema) {
    const properties: JsonObject = {};
    for (const [name, schema] of Object.entries(
      toJsonObject(jsonSchema['properties']),
    )) {
      properties[name] = connectorPayload(toJsonObject(schema));
    }
    openApiSchema['properties'] = properties;
  } else if (openApiSchema['type'] === 'array' && 'items' in jsonSchema) {
    const items = jsonSchema['items'];
    openApiSchema['items'] = Array.isArray(items)
      ? items.map((item) => connectorPayload(toJsonObject(item)))
      : connectorPayload(toJsonObject(items));
  }

  return openApiSchema;
}

/** Builds `{post: …}` for one connector operation. */
function postOperation(options: PostOperationOptions): JsonObject {
  const {summary, description, operationId, requestSchemaRef, responseSchema} =
    options;
  return {
    post: {
      summary,
      description,
      operationId,
      requestBody: {
        content: {
          'application/json': {
            schema: {$ref: requestSchemaRef},
          },
        },
      },
      responses: {
        '200': {
          description: 'Success response',
          content: {
            'application/json': {
              schema: responseSchema,
            },
          },
        },
      },
    },
  };
}

function entityIdRequest(): JsonObject {
  return {
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
      entityId: schemaRef('entityId'),
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      entity: schemaRef('entity'),
    },
  };
}

/**
 * Builds the path item that runs an action.
 *
 * @param options The action, operation, display name, tool name, and instructions.
 */
export function getActionOperation(
  options: GetActionOperationOptions,
): JsonObject {
  const {
    action,
    operation,
    actionDisplayName,
    toolName = '',
    toolInstructions = '',
  } = options;
  let description = `Use this tool with action = "${action}" and operation = "${operation}" only. Don't ask these values from user.`;
  if (operation === 'EXECUTE_QUERY') {
    description +=
      ' Use pageSize = 50 and timeout = 120 until user specifies a different value otherwise. If user provides a query in natural language, convert it to SQL query and then execute it using the tool.';
  }
  return postOperation({
    summary: actionDisplayName,
    description: `${description} ${toolInstructions}`,
    operationId: `${toolName}_${actionDisplayName}`,
    requestSchemaRef: `#/components/schemas/${actionDisplayName}_Request`,
    responseSchema: schemaRef(`${actionDisplayName}_Response`),
  });
}

/**
 * Builds the path item that lists the records of an entity.
 *
 * @param options The entity, schema string, tool name, and instructions.
 */
export function listOperation(
  options: EntitySchemaOperationOptions,
): JsonObject {
  const {
    entity,
    schemaAsString = '',
    toolName = '',
    toolInstructions = '',
  } = options;
  return postOperation({
    summary: `List ${entity}`,
    description: `Returns all entities of type ${entity}. Use this tool with entity = "${entity}" and operation = "LIST_ENTITIES" only. Don't ask these values from user. Always use "" as filter clause and "" as page token and 50 as page size until user specifies a different value otherwise. Use single quotes for strings in filter clause. ${toolInstructions}`,
    operationId: `${toolName}_list_${entity}`,
    requestSchemaRef: `#/components/schemas/list_${entity}_Request`,
    responseSchema: {
      description: `Returns a list of ${entity} of json schema: ${schemaAsString}`,
      $ref: '#/components/schemas/execute-connector_Response',
    },
  });
}

/**
 * Builds the path item that reads one record of an entity.
 *
 * @param options The entity, schema string, tool name, and instructions.
 */
export function getOperation(
  options: EntitySchemaOperationOptions,
): JsonObject {
  const {
    entity,
    schemaAsString = '',
    toolName = '',
    toolInstructions = '',
  } = options;
  return postOperation({
    summary: `Get ${entity}`,
    description: `Returns the details of the ${entity}. Use this tool with entity = "${entity}" and operation = "GET_ENTITY" only. Don't ask these values from user.  ${toolInstructions}`,
    operationId: `${toolName}_get_${entity}`,
    requestSchemaRef: `#/components/schemas/get_${entity}_Request`,
    responseSchema: {
      description: `Returns ${entity} of json schema: ${schemaAsString}`,
      $ref: '#/components/schemas/execute-connector_Response',
    },
  });
}

/**
 * Builds the path item that creates a record of an entity.
 *
 * @param options The entity, tool name, and instructions.
 */
export function createOperation(options: EntityOperationOptions): JsonObject {
  const {entity, toolName = '', toolInstructions = ''} = options;
  return postOperation({
    summary: `Create ${entity}`,
    description: `Creates a new entity of type ${entity}. Use this tool with entity = "${entity}" and operation = "CREATE_ENTITY" only. Don't ask these values from user. Follow the schema of the entity provided in the instructions to create ${entity}.  ${toolInstructions}`,
    operationId: `${toolName}_create_${entity}`,
    requestSchemaRef: `#/components/schemas/create_${entity}_Request`,
    responseSchema: schemaRef('execute-connector_Response'),
  });
}

/**
 * Builds the path item that updates a record of an entity.
 *
 * @param options The entity, tool name, and instructions.
 */
export function updateOperation(options: EntityOperationOptions): JsonObject {
  const {entity, toolName = '', toolInstructions = ''} = options;
  return postOperation({
    summary: `Update ${entity}`,
    description: `Updates an entity of type ${entity}. Use this tool with entity = "${entity}" and operation = "UPDATE_ENTITY" only. Don't ask these values from user. Use entityId to uniquely identify the entity to update. Follow the schema of the entity provided in the instructions to update ${entity}.  ${toolInstructions}`,
    operationId: `${toolName}_update_${entity}`,
    requestSchemaRef: `#/components/schemas/update_${entity}_Request`,
    responseSchema: schemaRef('execute-connector_Response'),
  });
}

/**
 * Builds the path item that deletes a record of an entity.
 *
 * @param options The entity, tool name, and instructions.
 */
export function deleteOperation(options: EntityOperationOptions): JsonObject {
  const {entity, toolName = '', toolInstructions = ''} = options;
  return postOperation({
    summary: `Delete ${entity}`,
    description: `Deletes an entity of type ${entity}. Use this tool with entity = "${entity}" and operation = "DELETE_ENTITY" only. Don't ask these values from user.  ${toolInstructions}`,
    operationId: `${toolName}_delete_${entity}`,
    requestSchemaRef: `#/components/schemas/delete_${entity}_Request`,
    responseSchema: schemaRef('execute-connector_Response'),
  });
}

/** Builds the request schema of the create operation of an entity. */
export function createOperationRequest(entity: string): JsonObject {
  return {
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
      connectorInputPayload: schemaRef(`connectorInputPayload_${entity}`),
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      entity: schemaRef('entity'),
    },
  };
}

/** Builds the request schema of the update operation of an entity. */
export function updateOperationRequest(entity: string): JsonObject {
  return {
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
      connectorInputPayload: schemaRef(`connectorInputPayload_${entity}`),
      entityId: schemaRef('entityId'),
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      entity: schemaRef('entity'),
    },
  };
}

/** Builds the request schema of the get operation. */
export function getOperationRequest(): JsonObject {
  return entityIdRequest();
}

/** Builds the request schema of the delete operation. */
export function deleteOperationRequest(): JsonObject {
  return entityIdRequest();
}

/** Builds the request schema of the list operation. */
export function listOperationRequest(): JsonObject {
  return {
    type: 'object',
    required: ['operation', 'connectionName', 'serviceName', 'host', 'entity'],
    properties: {
      filterClause: schemaRef('filterClause'),
      pageSize: schemaRef('pageSize'),
      pageToken: schemaRef('pageToken'),
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      entity: schemaRef('entity'),
    },
  };
}

/** Builds the request schema of an action. */
export function actionRequest(action: string): JsonObject {
  return {
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
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      action: schemaRef('action'),
      connectorInputPayload: schemaRef(`connectorInputPayload_${action}`),
    },
  };
}

/** Builds the response schema of an action. */
export function actionResponse(action: string): JsonObject {
  return {
    type: 'object',
    properties: {
      connectorOutputPayload: schemaRef(`connectorOutputPayload_${action}`),
    },
  };
}

/** Builds the request schema of the `ExecuteCustomQuery` action. */
export function executeCustomQueryRequest(): JsonObject {
  return {
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
      operation: schemaRef('operation'),
      connectionName: schemaRef('connectionName'),
      serviceName: schemaRef('serviceName'),
      host: schemaRef('host'),
      action: schemaRef('action'),
      query: schemaRef('query'),
      timeout: schemaRef('timeout'),
      pageSize: schemaRef('pageSize'),
    },
  };
}

/**
 * A client for the Integration Connectors API.
 *
 * It reads the details, entity schemas and action schemas of one connection.
 */
@experimental
export class ConnectionsClient {
  private readonly project: string;
  private readonly location: string;
  private readonly connection: string;
  private readonly tokenSource: CloudPlatformTokenSource;

  constructor(options: ConnectionsClientOptions) {
    this.project = options.project;
    this.location = options.location;
    this.connection = options.connection;
    this.tokenSource = new CloudPlatformTokenSource(options.serviceAccountJson);
  }

  /**
   * Reads the service name and host of the connection, and whether it allows
   * an authentication override.
   */
  async getConnectionDetails(): Promise<ConnectionDetails> {
    const url = `${CONNECTOR_URL}/v1/projects/${this.project}/locations/${this.location}/connections/${this.connection}?view=BASIC`;
    const connectionData = toJsonObject(await this.executeApiCall(url));
    const host = toStringValue(connectionData['host']);
    const serviceName = host
      ? toStringValue(connectionData['tlsServiceDirectory'])
      : toStringValue(connectionData['serviceDirectory']);
    const authOverrideEnabled = connectionData['authOverrideEnabled'] === true;
    return {serviceName, host, authOverrideEnabled};
  }

  /**
   * Reads the JSON schema of an entity and the operations it supports.
   *
   * @param entity The entity name.
   * @throws Error When the API starts no operation for the entity.
   */
  async getEntitySchemaAndOperations(
    entity: string,
  ): Promise<EntitySchemaAndOperations> {
    const url = `${CONNECTOR_URL}/v1/projects/${this.project}/locations/${this.location}/connections/${this.connection}/connectionSchemaMetadata:getEntityType?entityId=${entity}`;
    const operationId = toStringValue(
      toJsonObject(await this.executeApiCall(url))['name'],
    );
    if (!operationId) {
      throw new Error(
        `Failed to get entity schema and operations for entity: ${entity}`,
      );
    }

    const response = toJsonObject(
      (await this.pollOperation(operationId))['response'],
    );
    const operations = response['operations'];
    return {
      schema: toJsonObject(response['jsonSchema']),
      operations: Array.isArray(operations)
        ? operations.filter((op): op is string => typeof op === 'string')
        : [],
    };
  }

  /**
   * Reads the input and output JSON schemas of an action.
   *
   * @param action The action name.
   * @throws Error When the API starts no operation for the action.
   */
  async getActionSchema(action: string): Promise<ActionSchema> {
    const url = `${CONNECTOR_URL}/v1/projects/${this.project}/locations/${this.location}/connections/${this.connection}/connectionSchemaMetadata:getAction?actionId=${action}`;
    const operationId = toStringValue(
      toJsonObject(await this.executeApiCall(url))['name'],
    );
    if (!operationId) {
      throw new Error(`Failed to get action schema for action: ${action}`);
    }

    const response = toJsonObject(
      (await this.pollOperation(operationId))['response'],
    );
    return {
      inputSchema: toJsonObject(response['inputJsonSchema']),
      outputSchema: toJsonObject(response['outputJsonSchema']),
      description: toStringValue(response['description']),
      displayName: toStringValue(response['displayName']),
    };
  }

  /**
   * Converts the JSON schema of an entity or an action payload into the
   * OpenAPI schema the connector spec carries.
   */
  connectorPayload(jsonSchema: JsonObject): JsonObject {
    return connectorPayload(jsonSchema);
  }

  private executeApiCall(url: string): Promise<unknown> {
    return sendCloudRequest({
      url,
      method: 'GET',
      tokenSource: this.tokenSource,
      invalidRequestMessage: `Invalid request. Please check the provided values of project(${this.project}), location(${this.location}), connection(${this.connection}).`,
    });
  }

  /** Polls a long-running operation until it reports `done`. */
  private async pollOperation(operationId: string): Promise<JsonObject> {
    const url = `${CONNECTOR_URL}/v1/${operationId}`;
    let operation = toJsonObject(await this.executeApiCall(url));
    while (operation['done'] !== true) {
      await sleep(OPERATION_POLL_INTERVAL_MS);
      operation = toJsonObject(await this.executeApiCall(url));
    }
    return operation;
  }
}
