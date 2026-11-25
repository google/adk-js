/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  GoogleTool,
  type GoogleToolExecuteInput,
  isZodObject,
  type RequireConfirmation,
  type ToolInputParameters,
} from '@google/adk';

import type {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {
  BigQueryToolConfig,
  type BigQueryToolConfigOptions,
  isBigQueryToolConfig,
} from './config.js';

/**
 * Function wrapped by a {@link BigQueryTool}. It receives the validated model
 * arguments plus the resolved `credentials`, `config`, `settings`, and the tool
 * context.
 *
 * @deprecated Use `GoogleToolExecuteFunction` from `@google/adk` instead.
 */
export type BigQueryToolExecuteFunction<
  TParameters extends ToolInputParameters = ToolInputParameters,
> = (
  input: GoogleToolExecuteInput<TParameters, BigQueryToolConfig> & {
    config?: BigQueryToolConfig;
  },
  toolContext?: Context,
) => unknown;

/**
 * Configuration options for {@link BigQueryTool}.
 *
 * @deprecated Use `GoogleToolOptions` from `@google/adk` instead.
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
   * parameters. Do not declare `credentials`, `config`, or `settings`; the
   * tool injects them.
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
 *
 * @deprecated Use `isGoogleTool` from `@google/adk` instead.
 */
export function isBigQueryTool(obj: unknown): obj is BigQueryTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[BIGQUERY_TOOL_SIGNATURE_SYMBOL] === true
  );
}

function omitConfigParameter<TParameters extends ToolInputParameters>(
  parameters: TParameters,
): TParameters {
  if (!isZodObject(parameters) || !('config' in parameters.shape)) {
    return parameters;
  }
  // Keep TParameters inference on requireConfirmation while stripping config
  // from runtime Zod parsing.
  return (
    '_zod' in parameters
      ? parameters.omit({config: true})
      : parameters.omit({config: true})
  ) as TParameters;
}

/**
 * Function tool for BigQuery that resolves OAuth2 credentials, caches them in
 * session state, and reports failures as `{status: 'ERROR', error_details}`.
 *
 * @deprecated Use {@link GoogleTool} from `@google/adk` instead.
 */
export class BigQueryTool<
  TParameters extends ToolInputParameters = ToolInputParameters,
> extends GoogleTool<TParameters, BigQueryToolConfig> {
  readonly [BIGQUERY_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The configuration for BigQuery tools. Defaults to `new BigQueryToolConfig()`
   * when omitted.
   */
  readonly toolConfig: BigQueryToolConfig;

  /**
   * Parameter names omitted from the model's function declaration.
   */
  override readonly ignoreParams: readonly string[] = Object.freeze([
    'credentials',
    'config',
    'settings',
  ]);

  constructor(options: BigQueryToolOptions<TParameters>) {
    const name = options.name ?? options.execute.name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    const toolConfig = options.toolConfig
      ? isBigQueryToolConfig(options.toolConfig)
        ? options.toolConfig
        : new BigQueryToolConfig(options.toolConfig)
      : new BigQueryToolConfig();
    const execute = options.execute;

    super({
      name,
      description: options.description,
      parameters: omitConfigParameter(options.parameters),
      credentialsConfig: options.credentialsConfig,
      toolSettings: toolConfig,
      isLongRunning: options.isLongRunning,
      requireConfirmation: options.requireConfirmation,
      execute: (input, toolContext) =>
        execute({...input, config: toolConfig}, toolContext),
    });

    this.toolConfig = toolConfig;
  }
}
