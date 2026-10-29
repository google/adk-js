/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  FunctionTool,
  isZodObject,
  type RequireConfirmation,
  type RunAsyncToolRequest,
  type ToolExecuteFunction,
  type ToolInputParameters,
} from '@google/adk';
import type {FunctionDeclaration} from '@google/genai';

import {
  type BigQueryCredentialsConfig,
  GoogleCredentialsManager,
  type GoogleOAuthCredentials,
} from './bigquery_credentials.js';
import {
  getDatasetInfo,
  getDatasetInfoParameters,
  getTableInfo,
  getTableInfoParameters,
  listDatasetIds,
  listDatasetIdsParameters,
  listTableIds,
  listTableIdsParameters,
} from './metadata_tool.js';
import {executeSql, executeSqlParameters} from './query_tool.js';

/**
 * Function signature wrapped by a {@link BigQueryTool}.
 */
export type BigQueryToolCallable = {
  bivariance(args: object, toolContext?: Context): unknown | Promise<unknown>;
}['bivariance'];

interface BuiltInToolMetadata {
  name: string;
  description: string;
  parameters: ToolInputParameters;
}

const BUILTIN_TOOL_METADATA = new Map<
  BigQueryToolCallable,
  BuiltInToolMetadata
>([
  [
    listDatasetIds,
    {
      name: 'list_dataset_ids',
      description: 'List BigQuery dataset ids in a Google Cloud project.',
      parameters: listDatasetIdsParameters,
    },
  ],
  [
    getDatasetInfo,
    {
      name: 'get_dataset_info',
      description: 'Get metadata information about a BigQuery dataset.',
      parameters: getDatasetInfoParameters,
    },
  ],
  [
    listTableIds,
    {
      name: 'list_table_ids',
      description: 'List table ids in a BigQuery dataset.',
      parameters: listTableIdsParameters,
    },
  ],
  [
    getTableInfo,
    {
      name: 'get_table_info',
      description: 'Get metadata information about a BigQuery table.',
      parameters: getTableInfoParameters,
    },
  ],
  [
    executeSql,
    {
      name: 'execute_sql',
      description:
        'Run a BigQuery SQL query in the project and return the result.',
      parameters: executeSqlParameters,
    },
  ],
]);

/**
 * Configuration options for {@link BigQueryTool}.
 */
export interface BigQueryToolOptions<
  TParameters extends ToolInputParameters = ToolInputParameters,
> {
  /**
   * Callable implementing the tool's logic. Either `func` or `execute` must be provided.
   */
  func?: BigQueryToolCallable;

  /**
   * Alias for `func` matching {@link FunctionTool} options.
   */
  execute?: ToolExecuteFunction<TParameters>;

  /**
   * Optional explicit tool name. Defaults to the built-in tool name or `func.name`.
   */
  name?: string;

  /**
   * Optional tool description exposed to the LLM.
   */
  description?: string;

  /**
   * Optional Zod or `@google/genai` `Schema` describing tool input parameters.
   */
  parameters?: TParameters;

  /**
   * Optional BigQuery credentials configuration.
   */
  credentials?: BigQueryCredentialsConfig | null;

  /**
   * Alias for `credentials`.
   */
  credentialsConfig?: BigQueryCredentialsConfig | null;

  /**
   * Whether the tool is a long-running operation.
   */
  isLongRunning?: boolean;

  /**
   * Whether the tool requires user confirmation before execution.
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
 * Custom Google API tool wrapper for BigQuery tools that handles OAuth2
 * credential resolution, session caching, and structured error reporting.
 */
export class BigQueryTool<
  TParameters extends ToolInputParameters = ToolInputParameters,
> extends FunctionTool<TParameters> {
  readonly [BIGQUERY_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The underlying callable executed by the tool.
   */
  readonly func: BigQueryToolCallable;

  /**
   * The credential manager used to resolve OAuth2 credentials, or `null` when
   * no credential configuration is provided.
   */
  readonly credentialsManager: GoogleCredentialsManager | null;

  /**
   * Parameter names omitted from the LLM function declaration.
   */
  readonly ignoreParams: readonly string[] = Object.freeze(['credentials']);

  private readonly toolParameters?: TParameters;

  constructor(options: BigQueryToolOptions<TParameters>) {
    const rawFunc = (options.func ?? options.execute) as
      BigQueryToolCallable | undefined;
    if (typeof rawFunc !== 'function') {
      throw new Error(
        'BigQueryTool requires a `func` or `execute` callable in options.',
      );
    }

    const builtIn = BUILTIN_TOOL_METADATA.get(rawFunc);
    const funcMeta = rawFunc as {name?: string; __name__?: string};
    const resolvedName =
      options.name ??
      builtIn?.name ??
      (funcMeta.name || funcMeta.__name__ || 'bigquery_tool');
    const resolvedDescription =
      options.description ?? builtIn?.description ?? '';
    const resolvedParameters = (options.parameters ??
      builtIn?.parameters) as TParameters;

    super({
      name: resolvedName,
      description: resolvedDescription,
      parameters: resolvedParameters,
      execute: rawFunc as ToolExecuteFunction<TParameters>,
      isLongRunning: options.isLongRunning,
      requireConfirmation: options.requireConfirmation,
    });

    this.func = rawFunc;
    this.toolParameters = resolvedParameters;
    const credsConfig = options.credentials ?? options.credentialsConfig;
    this.credentialsManager = credsConfig
      ? new GoogleCredentialsManager(credsConfig)
      : null;
  }

  /**
   * Builds the `FunctionDeclaration` with `credentials` stripped from `properties`
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
   * Resolves OAuth2 credentials and executes the wrapped tool function,
   * returning a structured `{status: 'ERROR', error_details}` object on failure.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      const credentials = this.credentialsManager
        ? await this.credentialsManager.getValidCredentials(req.toolContext)
        : null;

      if (credentials === null && this.credentialsManager) {
        return (
          `User authorization is required to access Google services for ${this.name}. ` +
          'Please complete the authorization flow.'
        );
      }

      return await this.runAsyncWithCredential(
        credentials,
        req.args,
        req.toolContext,
      );
    } catch (error: unknown) {
      return {
        status: 'ERROR',
        error_details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runAsyncWithCredential(
    credentials: GoogleOAuthCredentials | null,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<unknown> {
    let validatedArgs: Record<string, unknown> = {...args};
    if (isZodObject(this.toolParameters)) {
      validatedArgs = this.toolParameters.parse(args) as Record<
        string,
        unknown
      >;
    }
    const resolvedCredentials =
      credentials ??
      (args['credentials'] as GoogleOAuthCredentials | undefined) ??
      undefined;
    const argsToCall: Record<string, unknown> = {
      ...validatedArgs,
      credentials: resolvedCredentials,
    };
    return await this.func(argsToCall, toolContext);
  }
}
