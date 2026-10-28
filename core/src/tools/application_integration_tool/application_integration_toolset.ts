/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {experimental} from '../../utils/experimental.js';
import {
  isJsonObject,
  JsonObject,
  toJsonObject,
} from '../../utils/json_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {serviceAccountDictToSchemeCredential} from '../openapi_tool/auth/auth_helpers.js';
import {OpenApiSpecParser} from '../openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {createRestApiTool} from '../openapi_tool/rest_api_tool.js';
import {CLOUD_PLATFORM_SCOPE} from './clients/cloud_request.js';
import {
  ConnectionsClient,
  ConnectorSpec,
} from './clients/connections_client.js';
import {IntegrationClient} from './clients/integration_client.js';
import {
  IntegrationConnectorTool,
  type IntegrationConnectorToolOptions,
} from './integration_connector_tool.js';

export {IntegrationConnectorTool, type IntegrationConnectorToolOptions};

/** The scheme the credential of every generated tool is applied with. */
const AUTH_SCHEME: OpenAPIV3.HttpSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
};

/** Options of {@link ApplicationIntegrationToolset}. */
export interface ApplicationIntegrationToolsetOptions {
  /** The Google Cloud project ID. */
  project: string;
  /** The Google Cloud location, such as `us-central1`. */
  location: string;
  /** The integration name. Set it together with `trigger` or `triggers`. */
  integration?: string;
  /** The API trigger ID of the integration, such as `api_trigger/my_trigger`. */
  trigger?: string;
  /**
   * The API trigger IDs of the integration, such as
   * `['api_trigger/my_trigger']`. When both `triggers` and `trigger` are
   * provided, `triggers` takes precedence.
   */
  triggers?: string[];
  /**
   * The Integration Connectors connection name. Set it together with
   * `entityOperations`, `actions`, or both.
   */
  connection?: string;
  /**
   * Operations to expose, keyed by entity name, such as
   * `{Issues: ['LIST', 'GET']}`. An empty list exposes every operation the
   * entity supports.
   */
  entityOperations?: Record<string, string[]>;
  /** Connection actions to expose, such as `['ExecuteCustomQuery']`. */
  actions?: string[];
  /** Prefix of every generated tool name. Defaults to `''`. */
  toolName?: string;
  /**
   * Prefix of every generated tool name. Takes precedence over `toolName` when
   * both are set.
   */
  toolNamePrefix?: string;
  /** Text appended to every generated tool description. Defaults to `''`. */
  toolInstructions?: string;
  /**
   * A service-account key, as a JSON string. It authenticates both the spec
   * requests and the generated tools. When omitted, both use Application
   * Default Credentials.
   */
  serviceAccountJson?: string;
  /**
   * Authentication scheme for dynamic end-user credentials on connection tools,
   * when `authOverrideEnabled` is enabled on the connection.
   */
  authScheme?: AuthScheme;
  /**
   * Authentication credential for dynamic end-user credentials on connection
   * tools, when `authOverrideEnabled` is enabled on the connection.
   */
  authCredential?: AuthCredential;
  /**
   * Filter used to select which generated tools are exposed by `getTools`.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * A toolset generated from a Google Cloud Application Integration API trigger,
 * or from the entity operations and actions of an Integration Connectors
 * connection.
 *
 * The constructor only validates the options. The first `getTools` call
 * fetches the spec and builds the tools, and later calls reuse them.
 *
 * @example
 * // Every operation of an integration API trigger.
 * const integrationToolset = new ApplicationIntegrationToolset({
 *   project: 'my-project',
 *   location: 'us-central1',
 *   integration: 'my-integration',
 *   trigger: 'api_trigger/my_trigger',
 * });
 *
 * @example
 * // Entity operations and actions of a connection.
 * const connectionToolset = new ApplicationIntegrationToolset({
 *   project: 'my-project',
 *   location: 'us-central1',
 *   connection: 'my-connection',
 *   entityOperations: {Issues: ['LIST', 'GET'], Projects: []},
 *   actions: ['ExecuteCustomQuery'],
 * });
 */
@experimental
export class ApplicationIntegrationToolset extends BaseToolset {
  private readonly options: ApplicationIntegrationToolsetOptions;
  private toolsPromise?: Promise<BaseTool[]>;
  private openApiToolsets: OpenAPIToolset[] = [];

  /**
   * @throws Error Unless the options name either an integration and a trigger,
   *   or a connection with at least one entity operation or action.
   */
  constructor(options: ApplicationIntegrationToolsetOptions) {
    super(options.toolFilter ?? []);
    const hasIntegration = Boolean(
      options.integration &&
      (options.trigger || options.triggers !== undefined),
    );
    const hasConnection = Boolean(
      options.connection &&
      (Object.keys(options.entityOperations ?? {}).length > 0 ||
        (options.actions ?? []).length > 0),
    );
    if (!hasIntegration && !hasConnection) {
      throw new Error(
        'Either (integration and trigger) or (connection and (entityOperations or actions)) should be provided.',
      );
    }
    this.options = options;
  }

  /**
   * Returns the generated tools.
   *
   * The first call fetches the spec and builds the tools. Concurrent calls
   * share that load. When it fails, the next call tries again.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.loadTools();
    }
    try {
      const tools = await this.toolsPromise;
      return tools.filter((tool) => this.isToolSelected(tool, context));
    } catch (e: unknown) {
      this.toolsPromise = undefined;
      throw e;
    }
  }

  override async close(): Promise<void> {
    for (const openApiToolset of this.openApiToolsets) {
      await openApiToolset.close();
    }
  }

  private async loadTools(): Promise<BaseTool[]> {
    const {
      project,
      location,
      integration,
      trigger,
      triggers,
      connection,
      entityOperations,
      actions,
      toolName,
      toolNamePrefix,
      toolInstructions = '',
      serviceAccountJson,
      authScheme,
      authCredential: dynamicAuthCredential,
    } = this.options;
    const resolvedToolName = toolNamePrefix ?? toolName ?? '';
    this.openApiToolsets = [];

    const integrationClient = new IntegrationClient({
      project,
      location,
      integration,
      trigger,
      triggers,
      connection,
      entityOperations,
      actions,
      serviceAccountJson,
    });

    const authCredential = buildAuthCredential(serviceAccountJson);
    const toolsByName = new Map<string, BaseTool>();

    if (integration && (trigger || triggers !== undefined)) {
      const specDict = await integrationClient.getOpenApiSpecForIntegration();
      const spec = toOpenApiDocument(specDict);
      for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
        const openApiToolset = new OpenAPIToolset({
          specDict: {...spec, paths: {[removeFragment(path)]: pathItem}},
          authCredential,
          authScheme: AUTH_SCHEME,
        });
        this.openApiToolsets.push(openApiToolset);
        const tools = await openApiToolset.getTools();
        for (const tool of tools) {
          toolsByName.set(tool.name, tool);
        }
      }
      return [...toolsByName.values()];
    }

    const connectionName = connection ?? '';
    const connectionDetails = await new ConnectionsClient({
      project,
      location,
      connection: connectionName,
      serviceAccountJson,
    }).getConnectionDetails();
    if (
      authScheme &&
      dynamicAuthCredential &&
      !connectionDetails.authOverrideEnabled
    ) {
      logger.warn(
        'Authentication schema and credentials are not used because authOverrideEnabled is not enabled in the connection.',
      );
    }
    const specDict = await integrationClient.getOpenApiSpecForConnection(
      resolvedToolName,
      toolInstructions,
    );
    const spec = toOpenApiDocument(specDict);
    addDynamicAuthConfigToConnectionSchemas(spec);
    const operations = new OpenApiSpecParser().parse(spec);
    // A connection spec tells its operations apart by a URL fragment, such as
    // `…?triggerId=api_trigger/ExecuteConnection#list_Issues`. A fragment is
    // never sent, and a tool would carry it into the query string, so each
    // operation has the fragment removed from its path.
    for (const openApiOperation of operations) {
      const operationObject = toJsonObject(openApiOperation.operation);
      const operation = toStringValue(operationObject['x-operation']);
      const entity = toStringValue(operationObject['x-entity']);
      const action = toStringValue(operationObject['x-action']);
      const restApiTool = createRestApiTool({
        ...openApiOperation,
        endpoint: {
          ...openApiOperation.endpoint,
          path: removeFragment(openApiOperation.endpoint.path),
        },
      });
      restApiTool.configureAuthScheme(AUTH_SCHEME);
      restApiTool.configureAuthCredential(authCredential);
      const tool = new IntegrationConnectorTool({
        name: restApiTool.name,
        description: restApiTool.description,
        connectionName: connectionDetails.name ?? '',
        connectionHost: connectionDetails.host,
        connectionServiceName: connectionDetails.serviceName,
        entity,
        action,
        operation,
        restApiTool,
        authScheme: connectionDetails.authOverrideEnabled
          ? authScheme
          : undefined,
        authCredential: connectionDetails.authOverrideEnabled
          ? dynamicAuthCredential
          : undefined,
      });
      toolsByName.set(tool.name, tool);
    }
    return [...toolsByName.values()];
  }
}

function addDynamicAuthConfigToConnectionSchemas(
  spec: OpenAPIV3.Document,
): void {
  const schemas = spec.components?.schemas;
  if (!schemas) {
    return;
  }
  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (
      schemaName.endsWith('_Request') &&
      isJsonObject(schema) &&
      isJsonObject(schema.properties) &&
      !('query' in schema.properties) &&
      !('dynamicAuthConfig' in schema.properties)
    ) {
      schema.properties = {
        ...schema.properties,
        dynamicAuthConfig: {
          $ref: '#/components/schemas/dynamicAuthConfig',
        },
      };
    }
  }
}

function toOpenApiDocument(
  specDict: JsonObject | ConnectorSpec,
): OpenAPIV3.Document {
  return specDict as OpenAPIV3.Document;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Builds the credential the generated tools carry: the given service account,
 * or Application Default Credentials.
 */
function buildAuthCredential(serviceAccountJson?: string): AuthCredential {
  if (!serviceAccountJson) {
    return {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
        scopes: [CLOUD_PLATFORM_SCOPE],
      },
    };
  }
  const key: unknown = JSON.parse(serviceAccountJson);
  if (!isJsonObject(key)) {
    throw new Error('serviceAccountJson must hold a JSON object.');
  }
  const [, authCredential] = serviceAccountDictToSchemeCredential(key, [
    CLOUD_PLATFORM_SCOPE,
  ]);
  return authCredential;
}

/** Returns `path` without its URL fragment. */
function removeFragment(path: string): string {
  const fragmentStart = path.indexOf('#');
  return fragmentStart === -1 ? path : path.slice(0, fragmentStart);
}
