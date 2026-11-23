/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  FunctionTool,
  type RequireConfirmation,
  type RunAsyncToolRequest,
  type ToolExecuteArgument,
  type ToolInputParameters,
} from '@google/adk';
import type {FunctionDeclaration} from '@google/genai';

import {
  type BigQueryCredentials,
  type BigQueryCredentialsConfig,
  GoogleCredentialsManager,
} from './bigquery_credentials.js';
import {
  BigQueryToolConfig,
  type BigQueryToolConfigOptions,
  isBigQueryToolConfig,
} from './config.js';
import {toBigQueryToolErrorResult} from './tool_error.js';

/**
 * Function wrapped by a {@link BigQueryTool}. It receives the validated model
 * arguments plus the resolved `credentials`, `config`, and the tool context.
 */
export type BigQueryToolExecuteFunction<
  TParameters extends ToolInputParameters,
> = (
  input: ToolExecuteArgument<TParameters> & {
    credentials?: BigQueryCredentials;
    config?: BigQueryToolConfig;
  },
  toolContext?: Context,
) => unknown;

/**
 * Configuration options for {@link BigQueryTool}.
 */
export interface BigQueryToolOptions<
  TParameters extends ToolInputParameters = ToolInputParameters,
> {
  /**
   * Tool name exposed to the model. Defaults to `execute.name`.
   */
  name?: string;

  /**
   * Tool description exposed to the model.
   */
  description: string;

  /**
   * Zod object schema or `@google/genai` `Schema` describing the model-facing
   * parameters. Do not declare `credentials` or `config`; the tool injects them.
   */
  parameters?: TParameters;

  /**
   * Function implementing the tool's logic.
   */
  execute: BigQueryToolExecuteFunction<TParameters>;

  /**
   * BigQuery credentials configuration. When omitted, `execute` receives
   * `credentials: undefined` and the BigQuery client falls back to Application
   * Default Credentials.
   */
  credentialsConfig?: BigQueryCredentialsConfig;

  /**
   * BigQuery tool configuration (such as write mode).
   */
  toolConfig?: BigQueryToolConfig | BigQueryToolConfigOptions;

  /**
   * Whether the tool is a long-running operation.
   */
  isLongRunning?: boolean;

  /**
   * Whether the tool requires user confirmation before it runs. Evaluated
   * before credentials are resolved.
   */
  requireConfirmation?: RequireConfirmation<TParameters>;
}

const BIGQUERY_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.bigQueryTool');

/**
 * Type guard to check if an object is an instance of {@link BigQueryTool}.
 */
export function isBigQueryTool(obj: unknown): obj is BigQueryTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[BIGQUERY_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Function tool for BigQuery that resolves OAuth2 credentials, caches them in
 * session state, and reports failures as `{status: 'ERROR', error_details}`.
 */
export class BigQueryTool<
  TParameters extends ToolInputParameters = ToolInputParameters,
> extends FunctionTool<TParameters> {
  readonly [BIGQUERY_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The credential manager used to resolve OAuth2 credentials, or `undefined`
   * when no credential configuration is provided.
   */
  readonly credentialsManager?: GoogleCredentialsManager;

  /**
   * The configuration for BigQuery tools, or `undefined` when not configured.
   */
  readonly toolConfig?: BigQueryToolConfig;

  /**
   * Parameter names omitted from the model's function declaration.
   */
  readonly ignoreParams: readonly string[] = Object.freeze([
    'credentials',
    'config',
  ]);

  constructor(options: BigQueryToolOptions<TParameters>) {
    const name = options.name ?? options.execute.name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    const credentialsManager = options.credentialsConfig
      ? new GoogleCredentialsManager(options.credentialsConfig)
      : undefined;
    const toolConfig = options.toolConfig
      ? isBigQueryToolConfig(options.toolConfig)
        ? options.toolConfig
        : new BigQueryToolConfig(options.toolConfig)
      : undefined;
    const execute = options.execute;

    super({
      name,
      description: options.description,
      parameters: options.parameters,
      isLongRunning: options.isLongRunning,
      requireConfirmation: options.requireConfirmation,
      execute: async (input, toolContext) => {
        try {
          let credentials: BigQueryCredentials | undefined;
          if (credentialsManager) {
            credentials =
              await credentialsManager.getValidCredentials(toolContext);
            if (!credentials) {
              return (
                `User authorization is required to access Google services for ${name}. ` +
                'Please complete the authorization flow.'
              );
            }
          }
          // A parameterless tool's validated input is not an object; it
          // receives only `credentials` and `config`.
          const argsToCall = {
            ...(typeof input === 'object' ? input : {}),
            credentials,
            config: toolConfig,
          } as Parameters<typeof execute>[0];
          return await execute(argsToCall, toolContext);
        } catch (error: unknown) {
          return toBigQueryToolErrorResult(error);
        }
      },
    });

    this.credentialsManager = credentialsManager;
    this.toolConfig = toolConfig;
  }

  /**
   * Builds the `FunctionDeclaration` with `credentials` and `config` stripped from `properties`
   * and `required`.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = structuredClone(super._getDeclaration());
    if (declaration.parameters?.properties) {
      for (const ignored of this.ignoreParams) {
        delete declaration.parameters.properties[ignored];
      }
    }
    if (Array.isArray(declaration.parameters?.required)) {
      declaration.parameters.required = declaration.parameters.required.filter(
        (param) => !this.ignoreParams.includes(param),
      );
    }
    return declaration;
  }

  /**
   * Runs the tool through {@link FunctionTool.runAsync}, so argument
   * validation and the `requireConfirmation` gate apply. Errors are returned
   * as `{status: 'ERROR', error_details}` instead of thrown.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (error: unknown) {
      return toBigQueryToolErrorResult(error);
    }
  }
}
