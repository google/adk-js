/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {isZodObject} from '../utils/simple_zod_to_json.js';
import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolExecuteFunction,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

export interface AuthenticatedToolOptions<
  TParameters extends ToolInputParameters,
> extends ToolOptions<TParameters> {
  authConfig?: AuthConfig;
  responseForAuthRequired?: string | Record<string, unknown>;
}

/**
 * A FunctionTool that handles authentication before the actual tool logic
 * gets called.
 *
 * If credentials are not available, it requests them through the context
 * and returns a pending response. Otherwise, it injects the credential
 * into the arguments passed to the execute function.
 *
 * @template TParameters The type of input parameters.
 */
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  private readonly innerExecute: ToolExecuteFunction<TParameters>;
  private readonly innerParameters?: TParameters;
  private readonly authConfig?: AuthConfig;
  private readonly responseForAuthRequired?: string | Record<string, unknown>;
  private readonly credentialManager?: CredentialManager;

  constructor(options: AuthenticatedToolOptions<TParameters>) {
    super(options);
    this.innerExecute = options.execute;
    this.innerParameters = options.parameters;
    this.authConfig = options.authConfig;
    this.responseForAuthRequired = options.responseForAuthRequired;

    if (this.authConfig && this.authConfig.authScheme) {
      this.credentialManager = new CredentialManager(this.authConfig);
    }
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    let credential = undefined;
    if (this.credentialManager) {
      credential = await this.credentialManager.getAuthCredential(
        req.toolContext,
      );
      if (!credential) {
        await this.credentialManager.requestCredential(req.toolContext);
        return this.responseForAuthRequired ?? 'Pending User Authorization.';
      }
    }

    try {
      let validatedArgs: unknown = req.args;
      if (isZodObject(this.innerParameters)) {
        validatedArgs = this.innerParameters.parse(req.args);
      }
      if (credential) {
        (validatedArgs as any).credential = credential;
      }
      return await this.innerExecute(
        validatedArgs as ToolExecuteArgument<TParameters>,
        req.toolContext,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error in tool '${this.name}': ${errorMessage}`);
    }
  }
}
