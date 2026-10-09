/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../../utils/experimental.js';
import {isJsonObject, JsonObject} from '../../../utils/json_utils.js';
import {
  CloudPlatformTokenSource,
  sendCloudRequest,
  unexpectedError,
} from './cloud_request.js';
import {
  actionRequest,
  actionResponse,
  ConnectionsClient,
  CONNECTOR_BASE_SPEC,
  connectorPayload,
  ConnectorSpec,
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
} from './connections_client.js';

/**
 * The integration every connection spec routes through. Application
 * Integration has to be provisioned in the region of the connection, with an
 * integration of this name and an API trigger `api_trigger/ExecuteConnection`.
 */
const EXECUTE_CONNECTION_INTEGRATION = 'ExecuteConnection';

/** The action that runs a custom query rather than a connector action. */
const EXECUTE_CUSTOM_QUERY_ACTION = 'ExecuteCustomQuery';

/** Options for {@link IntegrationClient}. */
export interface IntegrationClientOptions {
  /** The Google Cloud project ID. */
  project: string;
  /** The Google Cloud location, such as `us-central1`. */
  location: string;
  /** The integration name. */
  integration?: string;
  /** The API trigger ID of the integration. */
  trigger?: string;
  /** The connection name. */
  connection?: string;
  /**
   * Operations to expose, keyed by entity name, such as
   * `{Issues: ['LIST', 'GET']}`. An empty list exposes every operation the
   * entity supports.
   */
  entityOperations?: Record<string, string[]>;
  /** Actions to expose. */
  actions?: string[];
  /**
   * A service-account key, as a JSON string. When omitted, requests use
   * Application Default Credentials.
   */
  serviceAccountJson?: string;
}

/**
 * A client for Google Cloud Application Integration.
 *
 * It returns the OpenAPI spec of an integration API trigger, or builds one for
 * the entity operations and actions of an Integration Connectors connection.
 */
@experimental
export class IntegrationClient {
  private readonly project: string;
  private readonly location: string;
  private readonly integration?: string;
  private readonly trigger?: string;
  private readonly connection?: string;
  private readonly entityOperations: Record<string, string[]>;
  private readonly actions: string[];
  private readonly serviceAccountJson?: string;
  private readonly tokenSource: CloudPlatformTokenSource;

  constructor(options: IntegrationClientOptions) {
    this.project = options.project;
    this.location = options.location;
    this.integration = options.integration;
    this.trigger = options.trigger;
    this.connection = options.connection;
    this.entityOperations = options.entityOperations ?? {};
    this.actions = options.actions ?? [];
    this.serviceAccountJson = options.serviceAccountJson;
    this.tokenSource = new CloudPlatformTokenSource(options.serviceAccountJson);
  }

  /**
   * Fetches the OpenAPI spec Application Integration generates for the API
   * trigger of the integration.
   *
   * @throws Error For a rejected request, a missing credential, or a response
   *   that carries no parseable spec.
   */
  async getOpenApiSpecForIntegration(): Promise<JsonObject> {
    const url = `https://${this.location}-integrations.googleapis.com/v1/projects/${this.project}/locations/${this.location}:generateOpenApiSpec`;
    const body = await sendCloudRequest({
      url,
      method: 'POST',
      body: {
        apiTriggerResources: [
          {
            integrationResource: this.integration,
            triggerId: [this.trigger],
          },
        ],
        fileFormat: 'JSON',
      },
      tokenSource: this.tokenSource,
      invalidRequestMessage: `Invalid request. Please check the provided values of project(${this.project}), location(${this.location}), integration(${this.integration}) and trigger(${this.trigger}).`,
    });

    try {
      const spec = isJsonObject(body) ? body['openApiSpec'] : undefined;
      if (typeof spec !== 'string') {
        throw new Error('The response carries no openApiSpec string.');
      }
      const parsed: unknown = JSON.parse(spec);
      if (!isJsonObject(parsed)) {
        throw new Error('The openApiSpec is not a JSON object.');
      }
      return parsed;
    } catch (e: unknown) {
      throw unexpectedError(e);
    }
  }

  /**
   * Builds an OpenAPI spec for the entity operations and actions of the
   * connection.
   *
   * Every operation becomes a POST to the `ExecuteConnection` integration,
   * with a path fragment that keeps the paths distinct.
   *
   * @param toolName Prefix of every generated `operationId`.
   * @param toolInstructions Text appended to every operation description.
   * @throws Error When neither entity operations nor actions are configured,
   *   or an operation is not one of create, update, delete, list or get.
   */
  async getOpenApiSpecForConnection(
    toolName = '',
    toolInstructions = '',
  ): Promise<ConnectorSpec> {
    if (
      Object.keys(this.entityOperations).length === 0 &&
      this.actions.length === 0
    ) {
      throw new Error(
        'No entity operations or actions provided. Please provide at least one of them.',
      );
    }

    const connectionsClient = new ConnectionsClient({
      project: this.project,
      location: this.location,
      connection: this.connection ?? '',
      serviceAccountJson: this.serviceAccountJson,
    });
    const connectorSpec = structuredClone(CONNECTOR_BASE_SPEC);
    const schemas = connectorSpec.components.schemas;
    const pathPrefix = `/v2/projects/${this.project}/locations/${this.location}/integrations/${EXECUTE_CONNECTION_INTEGRATION}:execute?triggerId=api_trigger/${EXECUTE_CONNECTION_INTEGRATION}`;

    for (const [entity, requestedOperations] of Object.entries(
      this.entityOperations,
    )) {
      const {schema, operations: supportedOperations} =
        await connectionsClient.getEntitySchemaAndOperations(entity);
      const operations =
        requestedOperations.length > 0
          ? requestedOperations
          : supportedOperations;
      const schemaAsString = JSON.stringify(schema);
      schemas[`connectorInputPayload_${entity}`] = connectorPayload(schema);

      for (const operation of operations) {
        const operationLower = operation.toLowerCase();
        const path = `${pathPrefix}#${operationLower}_${entity}`;
        switch (operationLower) {
          case 'create':
            connectorSpec.paths[path] = createOperation({
              entity,
              toolName,
              toolInstructions,
            });
            schemas[`create_${entity}_Request`] =
              createOperationRequest(entity);
            break;
          case 'update':
            connectorSpec.paths[path] = updateOperation({
              entity,
              toolName,
              toolInstructions,
            });
            schemas[`update_${entity}_Request`] =
              updateOperationRequest(entity);
            break;
          case 'delete':
            connectorSpec.paths[path] = deleteOperation({
              entity,
              toolName,
              toolInstructions,
            });
            schemas[`delete_${entity}_Request`] = deleteOperationRequest();
            break;
          case 'list':
            connectorSpec.paths[path] = listOperation({
              entity,
              schemaAsString,
              toolName,
              toolInstructions,
            });
            schemas[`list_${entity}_Request`] = listOperationRequest();
            break;
          case 'get':
            connectorSpec.paths[path] = getOperation({
              entity,
              schemaAsString,
              toolName,
              toolInstructions,
            });
            schemas[`get_${entity}_Request`] = getOperationRequest();
            break;
          default:
            throw new Error(
              `Invalid operation: ${operation} for entity: ${entity}`,
            );
        }
      }
    }

    for (const action of this.actions) {
      const {inputSchema, outputSchema, displayName} =
        await connectionsClient.getActionSchema(action);
      let operation = 'EXECUTE_ACTION';
      if (action === EXECUTE_CUSTOM_QUERY_ACTION) {
        schemas[`${action}_Request`] = executeCustomQueryRequest();
        operation = 'EXECUTE_QUERY';
      } else {
        schemas[`${displayName}_Request`] = actionRequest(displayName);
        schemas[`connectorInputPayload_${displayName}`] =
          connectorPayload(inputSchema);
      }
      schemas[`connectorOutputPayload_${displayName}`] =
        connectorPayload(outputSchema);
      schemas[`${displayName}_Response`] = actionResponse(displayName);
      connectorSpec.paths[`${pathPrefix}#${action}`] = getActionOperation({
        action,
        operation,
        actionDisplayName: displayName,
        toolName,
        toolInstructions,
      });
    }

    return connectorSpec;
  }
}
