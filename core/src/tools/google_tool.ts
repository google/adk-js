/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema} from '@google/genai';

import {Context} from '../agents/context.js';
import {SchemaLike} from '../utils/schema.js';
import {isZodObject, isZodV4Schema} from '../utils/simple_zod_to_json.js';
import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  RequireConfirmation,
  ToolExecuteArgument,
  ToolInputParameters,
} from './function_tool.js';
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentials,
  GoogleCredentialsManager,
} from './google_credentials.js';

const GOOGLE_TOOL_IGNORED_PARAMS = ['credentials', 'settings'] as const;

/**
 * Resolved argument payload passed to {@link GoogleTool.runAsyncWithCredential}.
 */
export interface RunAsyncWithCredentialRequest<
  TParameters extends ToolInputParameters = ToolInputParameters,
  TSettings = unknown,
> {
  /**
   * Valid Google OAuth2 credentials or auth client, if configured.
   */
  credentials?: GoogleCredentials;

  /**
   * Tool-specific settings configured on the {@link GoogleTool}.
   */
  toolSettings?: TSettings;

  /**
   * Validated model-supplied arguments for the tool call.
   */
  args: ToolExecuteArgument<TParameters>;

  /**
   * Tool execution context.
   */
  toolContext: Context;
}

/**
 * Input object passed to {@link GoogleToolExecuteFunction}, combining the
 * validated model arguments with injected `credentials` and `settings`.
 */
export type GoogleToolExecuteInput<
  TParameters extends ToolInputParameters,
  TSettings = unknown,
> = (TParameters extends undefined
  ? Record<string, unknown>
  : TParameters extends Schema
    ? Record<string, unknown>
    : ToolExecuteArgument<TParameters>) & {
  credentials?: GoogleCredentials;
  settings?: TSettings;
};

/**
 * Function executed by a {@link GoogleTool}. Receives the validated model
 * arguments together with resolved `credentials`, `settings`, and `toolContext`.
 */
export type GoogleToolExecuteFunction<
  TParameters extends ToolInputParameters = ToolInputParameters,
  TSettings = unknown,
> = (
  input: GoogleToolExecuteInput<TParameters, TSettings>,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/**
 * Configuration options for {@link GoogleTool}.
 */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters = ToolInputParameters,
  TSettings = unknown,
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
   * Zod object schema or `@google/genai` `Schema` describing model-facing
   * parameters. Any `credentials` or `settings` parameters are omitted from the
   * declaration and overwritten at runtime.
   */
  parameters?: TParameters;

  /**
   * Optional schema describing the tool's return value.
   */
  response?: SchemaLike;

  /**
   * Function implementing the tool's logic.
   */
  execute: GoogleToolExecuteFunction<TParameters, TSettings>;

  /**
   * Google credentials configuration. When omitted, `execute` receives
   * `credentials: undefined`.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;

  /**
   * Tool-specific settings injected as `settings` when `execute` runs.
   */
  toolSettings?: TSettings;

  /**
   * Whether the tool is a long-running operation.
   */
  isLongRunning?: boolean;

  /**
   * Optional JSON-serializable key-value metadata associated with the tool.
   */
  customMetadata?: Record<string, unknown>;

  /**
   * Whether this tool requires user confirmation before execution. Evaluated
   * before credentials are resolved.
   */
  requireConfirmation?: RequireConfirmation<TParameters>;
}

interface GoogleToolErrorResult {
  status: 'ERROR';
  error_details: string;
}

function formatGoogleToolError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized !== undefined) {
        return serialized;
      }
    } catch {
      // Fall through to String() for values that JSON cannot serialize.
    }
  }
  return String(error);
}

function toGoogleToolErrorResult(error: unknown): GoogleToolErrorResult {
  return {
    status: 'ERROR',
    error_details: formatGoogleToolError(error),
  };
}

function omitIgnoredParametersFromZod(
  parameters: ToolInputParameters,
  ignoreParams: readonly string[],
): ToolInputParameters {
  if (!isZodObject(parameters)) {
    return parameters;
  }
  const omitMask: Record<string, true> = {};
  let hasIgnored = false;
  for (const param of ignoreParams) {
    if (param in parameters.shape) {
      omitMask[param] = true;
      hasIgnored = true;
    }
  }
  if (!hasIgnored) {
    return parameters;
  }
  return isZodV4Schema(parameters)
    ? parameters.omit(omitMask)
    : parameters.omit(omitMask);
}

function hasIgnoredArgKeys(
  args: Record<string, unknown>,
  ignoreParams: readonly string[],
): boolean {
  return ignoreParams.some((param) => Object.hasOwn(args, param));
}

function stripIgnoredArgKeys(
  args: Record<string, unknown>,
  ignoreParams: readonly string[],
): Record<string, unknown> {
  const sanitized = {...args};
  for (const param of ignoreParams) {
    delete sanitized[param];
  }
  return sanitized;
}

function sanitizeIgnoredArgs(
  args: Record<string, unknown>,
  ignoreParams: readonly string[],
): Record<string, unknown> {
  return hasIgnoredArgKeys(args, ignoreParams)
    ? stripIgnoredArgKeys(args, ignoreParams)
    : args;
}

const GOOGLE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.googleTool');

/**
 * Type guard checking whether an object is an instance of {@link GoogleTool}.
 */
export function isGoogleTool(obj: unknown): obj is GoogleTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Function tool for Google APIs that manages OAuth2 credentials, injects tool
 * settings, strips internal parameters from model declarations, and catches
 * failures into `{status: 'ERROR', error_details}`.
 */
export class GoogleTool<
  TParameters extends ToolInputParameters = ToolInputParameters,
  TSettings = unknown,
> extends FunctionTool<TParameters> {
  readonly [GOOGLE_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * Credential manager used to resolve Google API credentials, or `undefined`
   * when no `credentialsConfig` is configured.
   */
  readonly credentialsManager?: GoogleCredentialsManager;

  /**
   * Tool-specific settings passed to {@link runAsyncWithCredential} and the
   * underlying `execute` callback.
   */
  readonly toolSettings?: TSettings;

  /**
   * Parameter names omitted from the model's `FunctionDeclaration`.
   */
  readonly ignoreParams: readonly string[] = Object.freeze([
    ...GOOGLE_TOOL_IGNORED_PARAMS,
  ]);

  private readonly googleExecute: GoogleToolExecuteFunction<
    TParameters,
    TSettings
  >;

  constructor(options: GoogleToolOptions<TParameters, TSettings>) {
    const name = options.name ?? options.execute.name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }

    super({
      name,
      description: options.description,
      // Cast keeps TParameters inference on requireConfirmation while stripping
      // internal credentials/settings fields from runtime Zod parsing.
      parameters: omitIgnoredParametersFromZod(
        options.parameters,
        GOOGLE_TOOL_IGNORED_PARAMS,
      ) as TParameters,
      response: options.response,
      isLongRunning: options.isLongRunning,
      customMetadata: options.customMetadata,
      requireConfirmation: options.requireConfirmation,
      execute: () => undefined,
    });

    this.googleExecute = options.execute;
    this.credentialsManager = options.credentialsConfig
      ? new GoogleCredentialsManager(options.credentialsConfig)
      : undefined;
    this.toolSettings = options.toolSettings;
  }

  /**
   * Returns a non-mutating copy of the `FunctionDeclaration` with
   * `credentials` and `settings` removed from `parameters`.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = structuredClone(super._getDeclaration());
    if (declaration.parameters?.properties) {
      for (const ignored of this.ignoreParams) {
        delete declaration.parameters.properties[ignored];
      }
    }
    if (Array.isArray(declaration.parameters?.required)) {
      const filtered = declaration.parameters.required.filter(
        (param) => !this.ignoreParams.includes(param),
      );
      if (filtered.length > 0) {
        declaration.parameters.required = filtered;
      } else {
        delete declaration.parameters.required;
      }
    }
    return declaration;
  }

  /**
   * Executes the tool through {@link FunctionTool.runAsync} (applying schema
   * validation and the `requireConfirmation` gate before credential
   * resolution) and catches failures into `{status: 'ERROR', error_details}`.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      const sanitizedArgs = sanitizeIgnoredArgs(req.args, this.ignoreParams);
      const sanitizedReq =
        sanitizedArgs === req.args ? req : {...req, args: sanitizedArgs};
      return await super.runAsync(sanitizedReq);
    } catch (error: unknown) {
      return toGoogleToolErrorResult(error);
    }
  }

  /**
   * Checks whether this tool call requires confirmation after stripping
   * internal parameter keys (`credentials`, `settings`) so predicates see the
   * same sanitized arguments as {@link runAsync}.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    return super.checkRequireConfirmation(
      sanitizeIgnoredArgs(args, this.ignoreParams),
      toolContext,
    );
  }

  /**
   * Resolves credentials via {@link GoogleCredentialsManager} after
   * validation and confirmation, then delegates to
   * {@link runAsyncWithCredential}.
   */
  protected override async invokeExecute(
    input: ToolExecuteArgument<TParameters>,
    req: RunAsyncToolRequest,
  ): Promise<unknown> {
    try {
      let credentials: GoogleCredentials | undefined;
      if (this.credentialsManager) {
        credentials = await this.credentialsManager.getValidCredentials(
          req.toolContext,
        );
        if (!credentials) {
          return (
            `User authorization is required to access Google services for ${this.name}. ` +
            'Please complete the authorization flow.'
          );
        }
      }
      return await this.runAsyncWithCredential({
        credentials,
        toolSettings: this.toolSettings,
        args: input,
        toolContext: req.toolContext,
      });
    } catch (error: unknown) {
      return toGoogleToolErrorResult(error);
    }
  }

  /**
   * Executes the tool logic with resolved `credentials` and `toolSettings`,
   * ensuring any model-supplied `credentials` or `settings` values are
   * overwritten.
   */
  protected async runAsyncWithCredential(
    request: RunAsyncWithCredentialRequest<TParameters, TSettings>,
  ): Promise<unknown> {
    const baseArgs =
      typeof request.args === 'object' && request.args !== null
        ? (request.args as Record<string, unknown>)
        : {};
    const argsToCall = {
      ...baseArgs,
      credentials: request.credentials,
      settings: request.toolSettings,
    } as GoogleToolExecuteInput<TParameters, TSettings>;
    return await this.googleExecute(argsToCall, request.toolContext);
  }
}
