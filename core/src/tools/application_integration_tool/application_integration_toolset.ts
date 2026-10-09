/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {isJsonObject, JsonObject} from '../../utils/json_utils.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset} from '../base_toolset.js';
import {serviceAccountDictToSchemeCredential} from '../openapi_tool/auth/auth_helpers.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {CLOUD_PLATFORM_SCOPE} from './clients/cloud_request.js';
import {
  ConnectionsClient,
  ConnectorSpec,
} from './clients/connections_client.js';
import {IntegrationClient} from './clients/integration_client.js';

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
  /** The integration name. Set it together with `trigger`. */
  integration?: string;
  /** The API trigger ID of the integration, such as `api_trigger/my_trigger`. */
  trigger?: string;
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
  /** Text appended to every generated tool description. Defaults to `''`. */
  toolInstructions?: string;
  /**
   * A service-account key, as a JSON string. It authenticates both the spec
   * requests and the generated tools. When omitted, both use Application
   * Default Credentials.
   */
  serviceAccountJson?: string;
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

  /**
   * @throws Error Unless the options name either an integration and a trigger,
   *   or a connection with at least one entity operation or action.
   */
  constructor(options: ApplicationIntegrationToolsetOptions) {
    super([]);
    const hasIntegration = Boolean(options.integration && options.trigger);
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
  override async getTools(): Promise<BaseTool[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.loadTools();
    }
    try {
      return await this.toolsPromise;
    } catch (e: unknown) {
      this.toolsPromise = undefined;
      throw e;
    }
  }

  override async close(): Promise<void> {}

  private async loadTools(): Promise<BaseTool[]> {
    const {
      project,
      location,
      integration,
      trigger,
      connection,
      entityOperations,
      actions,
      toolName = '',
      toolInstructions = '',
      serviceAccountJson,
    } = this.options;
    const integrationClient = new IntegrationClient({
      project,
      location,
      integration,
      trigger,
      connection,
      entityOperations,
      actions,
      serviceAccountJson,
    });

    let specDict: JsonObject | ConnectorSpec;
    if (integration && trigger) {
      specDict = await integrationClient.getOpenApiSpecForIntegration();
    } else {
      const connectionName = connection ?? '';
      const {serviceName, host} = await new ConnectionsClient({
        project,
        location,
        connection: connectionName,
        serviceAccountJson,
      }).getConnectionDetails();
      const instructions = `${toolInstructions}ALWAYS use serviceName = ${serviceName}, host = ${host} and the connection name = projects/${project}/locations/${location}/connections/${connectionName} when using this tool. DO NOT ask the user for these values as you already have those.`;
      specDict = await integrationClient.getOpenApiSpecForConnection(
        toolName,
        instructions,
      );
    }

    const spec = specDict as OpenAPIV3.Document;
    const authCredential = buildAuthCredential(serviceAccountJson);
    const toolsByName = new Map<string, BaseTool>();
    // A connection spec tells its operations apart by a URL fragment, such as
    // `…?triggerId=api_trigger/ExecuteConnection#list_Issues`. A fragment is
    // never sent, and a tool would carry it into the query string, so each
    // path is turned into tools on its own with the fragment removed.
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      const tools = await new OpenAPIToolset({
        specDict: {...spec, paths: {[removeFragment(path)]: pathItem}},
        authCredential,
        authScheme: AUTH_SCHEME,
      }).getTools();
      for (const tool of tools) {
        toolsByName.set(tool.name, tool);
      }
    }
    return [...toolsByName.values()];
  }
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
