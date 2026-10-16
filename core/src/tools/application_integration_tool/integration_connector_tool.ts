/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema} from '@google/genai';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, BaseToolParams, RunAsyncToolRequest} from '../base_tool.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

/** Options for {@link IntegrationConnectorTool}. */
export interface IntegrationConnectorToolOptions extends BaseToolParams {
  /** The Integration Connectors connection resource name. */
  connectionName: string;
  /** The host of the connection, or `''` when it has none. */
  connectionHost: string;
  /** The Service Directory name of the connection. */
  connectionServiceName: string;
  /** The Integration Connectors entity targeted by the tool, if any. */
  entity?: string;
  /** The connector operation executed by the tool, if any. */
  operation?: string;
  /** The connector action executed by the tool, if any. */
  action?: string;
  /** The underlying {@link RestApiTool} that executes the HTTP request. */
  restApiTool: RestApiTool;
}

/**
 * Wraps a {@link RestApiTool} for an Integration Connectors operation, hiding
 * connection and routing fields from the model declaration and injecting them
 * when the tool runs.
 */
@experimental
export class IntegrationConnectorTool extends BaseTool {
  /**
   * Request fields that {@link IntegrationConnectorTool} injects at runtime and
   * excludes from the function declaration shown to the model.
   */
  static readonly EXCLUDE_FIELDS: readonly string[] = Object.freeze([
    'connection_name',
    'connectionName',
    'service_name',
    'serviceName',
    'host',
    'entity',
    'operation',
    'action',
  ]);

  /**
   * Request fields that {@link IntegrationConnectorTool} removes from the
   * `required` list in the function declaration shown to the model.
   */
  static readonly OPTIONAL_FIELDS: readonly string[] = Object.freeze([
    'page_size',
    'pageSize',
    'page_token',
    'pageToken',
    'filter',
    'filter_clause',
    'filterClause',
  ]);

  readonly connectionName: string;
  readonly connectionHost: string;
  readonly connectionServiceName: string;
  readonly entity: string;
  readonly operation: string;
  readonly action: string;
  readonly restApiTool: RestApiTool;

  constructor(options: IntegrationConnectorToolOptions) {
    super(options);
    this.connectionName = options.connectionName;
    this.connectionHost = options.connectionHost;
    this.connectionServiceName = options.connectionServiceName;
    this.entity = options.entity ?? '';
    this.operation = options.operation ?? '';
    this.action = options.action ?? '';
    this.restApiTool = options.restApiTool;
  }

  /**
   * Returns the Gemini `FunctionDeclaration` with connection routing fields
   * removed from `parameters.properties` and optional and excluded fields
   * removed from `parameters.required`.
   */
  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const declaration = this.restApiTool._getDeclaration();
    const rawParameters = declaration?.parameters;
    let parameters: Schema | undefined;
    if (rawParameters) {
      parameters = {...rawParameters};
      if (rawParameters.properties) {
        const properties = {...rawParameters.properties};
        for (const field of IntegrationConnectorTool.EXCLUDE_FIELDS) {
          delete properties[field];
        }
        parameters.properties = properties;
      }
      if (rawParameters.required) {
        parameters.required = rawParameters.required.filter(
          (field) =>
            !IntegrationConnectorTool.EXCLUDE_FIELDS.includes(field) &&
            !IntegrationConnectorTool.OPTIONAL_FIELDS.includes(field),
        );
      }
    }
    return {
      name: this.name,
      description: this.description,
      parameters,
    };
  }

  /**
   * Injects the connection details and the configured entity, operation, and
   * action into a copy of `request.args` and delegates execution to the wrapped
   * {@link RestApiTool}.
   */
  @experimental
  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const updatedArgs: Record<string, unknown> = {
      ...request.args,
      connection_name: this.connectionName,
      connectionName: this.connectionName,
      service_name: this.connectionServiceName,
      serviceName: this.connectionServiceName,
      host: this.connectionHost,
    };
    if (this.entity) {
      updatedArgs['entity'] = this.entity;
    }
    if (this.operation) {
      updatedArgs['operation'] = this.operation;
    }
    if (this.action) {
      updatedArgs['action'] = this.action;
    }
    logger.debug(`Running tool: ${this.name}`);
    return this.restApiTool.runAsync({
      args: updatedArgs,
      toolContext: request.toolContext,
    });
  }
}
