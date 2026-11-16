/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {Context} from '../agents/context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {logger} from '../utils/logger.js';
import {isZodObject, isZodV4Schema} from '../utils/simple_zod_to_json.js';

import {RunAsyncAuthenticatedToolRequest} from './base_authenticated_tool.js';
import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

const DEFAULT_RESPONSE_FOR_AUTH_REQUIRED = 'Pending User Authorization.';
const CREDENTIAL_PARAM_NAME = 'credential';

const AUTHENTICATED_FUNCTION_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.authenticatedFunctionTool',
);

/**
 * Type guard to check if an object is an instance of {@link AuthenticatedFunctionTool}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of {@link AuthenticatedFunctionTool}.
 */
export function isAuthenticatedFunctionTool(
  obj: unknown,
): obj is AuthenticatedFunctionTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    AUTHENTICATED_FUNCTION_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[AUTHENTICATED_FUNCTION_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The signature of the user-provided function executed by an {@link AuthenticatedFunctionTool}.
 */
export type AuthenticatedToolExecuteFunction<
  TParameters extends ToolInputParameters = undefined,
> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext?: Context,
  credential?: AuthCredential,
) => Promise<unknown> | unknown;

/**
 * The configuration options for creating an {@link AuthenticatedFunctionTool}.
 */
export type AuthenticatedFunctionToolOptions<
  TParameters extends ToolInputParameters = undefined,
> = Omit<ToolOptions<TParameters>, 'execute'> & {
  /**
   * The function invoked with the validated tool input, tool context, and
   * resolved authentication credential.
   */
  execute: AuthenticatedToolExecuteFunction<TParameters>;

  /**
   * The authentication configuration of the tool.
   */
  authConfig?: AuthConfig;

  /**
   * The response to return when the tool requests an authentication credential
   * from the client.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
};

function stripCredentialFromParametersSchema(parameters: Schema): Schema {
  if (
    !parameters.properties ||
    !(CREDENTIAL_PARAM_NAME in parameters.properties)
  ) {
    return parameters;
  }
  const restProperties = {...parameters.properties};
  delete restProperties[CREDENTIAL_PARAM_NAME];
  const filteredRequired = parameters.required?.filter(
    (key) => key !== CREDENTIAL_PARAM_NAME,
  );
  const nextParameters: Schema = {
    ...parameters,
    properties: restProperties,
  };
  if (parameters.required !== undefined) {
    if (filteredRequired && filteredRequired.length > 0) {
      nextParameters.required = filteredRequired;
    } else {
      delete nextParameters.required;
    }
  }
  return nextParameters;
}

/**
 * Removes a `credential` property from the parameter schema, so the model is
 * never asked for it and Zod validation does not require it. The tool passes
 * the resolved credential to `execute` as its third argument instead.
 */
function omitCredentialParameter(
  parameters: ToolInputParameters,
): ToolInputParameters {
  if (parameters === undefined) {
    return parameters;
  }
  if (isZodObject(parameters)) {
    if (!(CREDENTIAL_PARAM_NAME in parameters.shape)) {
      return parameters;
    }
    const mask = {[CREDENTIAL_PARAM_NAME]: true} as const;
    return isZodV4Schema(parameters)
      ? parameters.omit(mask)
      : parameters.omit(mask);
  }
  return stripCredentialFromParametersSchema(parameters);
}

/**
 * A {@link FunctionTool} that handles authentication via {@link CredentialManager}
 * before invoking the wrapped function.
 *
 * The resolved credential is passed to `execute` as its third argument. A
 * `credential` property declared in `parameters` is removed from the schema
 * the model sees and from the schema used to validate the call.
 */
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  readonly [AUTHENTICATED_FUNCTION_TOOL_SIGNATURE_SYMBOL] = true;

  protected readonly authConfig?: AuthConfig;
  protected readonly credentialsManager?: CredentialManager;
  protected readonly responseForAuthRequired?: Record<string, unknown> | string;
  private readonly executeWithCredential: AuthenticatedToolExecuteFunction<TParameters>;

  /**
   * Initializes the {@link AuthenticatedFunctionTool}.
   *
   * @param options The configuration options for the authenticated function tool.
   */
  constructor(options: AuthenticatedFunctionToolOptions<TParameters>) {
    const name = options.name ?? options.execute.name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    super({
      ...options,
      name,
      // Removing `credential` changes the inferred argument type, but the
      // callback gets the credential as its third argument, not in `input`.
      parameters: omitCredentialParameter(options.parameters) as TParameters,
    });
    this.executeWithCredential = options.execute;

    this.authConfig = options.authConfig;
    if (options.authConfig?.authScheme) {
      this.credentialsManager = new CredentialManager(options.authConfig);
    } else {
      logger.debug(
        'authConfig or authConfig.authScheme is missing, so authentication will be skipped.',
      );
    }
    this.responseForAuthRequired = options.responseForAuthRequired;
  }

  /**
   * Resolves the authentication credential (requesting one from the client if
   * unavailable) and runs the wrapped function tool.
   *
   * @param req The tool request containing arguments and tool context.
   * @returns A promise resolving to the function's return value or the pending
   *     authorization response.
   */
  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    let credential: AuthCredential | undefined;
    if (this.credentialsManager) {
      credential = await this.credentialsManager.getAuthCredential(toolContext);
      if (!credential) {
        await this.credentialsManager.requestCredential(toolContext);
        return (
          this.responseForAuthRequired ?? DEFAULT_RESPONSE_FOR_AUTH_REQUIRED
        );
      }
    }

    return this.runAsyncImpl({
      args,
      toolContext,
      credential,
    });
  }

  /**
   * Executes the wrapped function tool with the resolved credential.
   *
   * The credential travels on the request through {@link FunctionTool.runAsync}
   * to {@link invokeExecute}, so concurrent calls never share it.
   *
   * @param request The authenticated tool execution request.
   * @returns A promise resolving to the function's return value.
   */
  protected async runAsyncImpl(
    request: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown> {
    return super.runAsync(request);
  }

  /**
   * Calls the wrapped function with the validated input, the tool context, and
   * the credential resolved for this call.
   *
   * @param input The validated arguments.
   * @param req The request passed to {@link runAsyncImpl}.
   * @returns The return value of the wrapped function.
   */
  protected override invokeExecute(
    input: ToolExecuteArgument<TParameters>,
    req: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown> | unknown {
    return this.executeWithCredential(input, req.toolContext, req.credential);
  }
}
