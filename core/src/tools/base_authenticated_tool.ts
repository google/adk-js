/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {logger} from '../utils/logger.js';

import {BaseTool, BaseToolParams, RunAsyncToolRequest} from './base_tool.js';

const DEFAULT_RESPONSE_FOR_AUTH_REQUIRED = 'Pending User Authorization.';

const BASE_AUTHENTICATED_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.baseAuthenticatedTool',
);

/**
 * Type guard to check if an object is an instance of {@link BaseAuthenticatedTool}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of {@link BaseAuthenticatedTool}.
 */
export function isBaseAuthenticatedTool(
  obj: unknown,
): obj is BaseAuthenticatedTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_AUTHENTICATED_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BASE_AUTHENTICATED_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Parameters for the {@link BaseAuthenticatedTool} constructor.
 */
export interface BaseAuthenticatedToolParams extends BaseToolParams {
  /**
   * The authentication configuration of the tool.
   */
  authConfig?: AuthConfig;

  /**
   * The response to return when the tool requests an authentication credential
   * from the client.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * The parameters for {@link BaseAuthenticatedTool.runAsyncImpl}.
 */
export interface RunAsyncAuthenticatedToolRequest extends RunAsyncToolRequest {
  /**
   * The resolved authentication credential, or `undefined` when the tool runs
   * without an authentication configuration.
   */
  credential?: AuthCredential;
}

/**
 * An abstract base tool class that resolves authentication credentials before
 * running the tool logic.
 */
export abstract class BaseAuthenticatedTool extends BaseTool {
  readonly [BASE_AUTHENTICATED_TOOL_SIGNATURE_SYMBOL] = true;

  protected readonly authConfig?: AuthConfig;
  protected readonly credentialsManager?: CredentialManager;
  protected readonly responseForAuthRequired?: Record<string, unknown> | string;

  /**
   * Initializes a {@link BaseAuthenticatedTool}.
   *
   * @param params The parameters for the authenticated tool.
   */
  constructor(params: BaseAuthenticatedToolParams) {
    super(params);
    this.authConfig = params.authConfig;

    if (params.authConfig?.authScheme) {
      this.credentialsManager = new CredentialManager(params.authConfig);
    } else {
      logger.debug(
        'authConfig or authConfig.authScheme is missing, so authentication will be skipped.',
      );
    }
    this.responseForAuthRequired = params.responseForAuthRequired;
  }

  /**
   * Resolves the authentication credential (requesting one from the client if
   * unavailable) and delegates to {@link runAsyncImpl}.
   *
   * @param request The request to run the tool.
   * @returns A promise that resolves to the tool response.
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
   * Executes the tool logic with the resolved credential.
   *
   * @param request The authenticated tool execution request.
   * @returns A promise that resolves to the tool response.
   */
  protected abstract runAsyncImpl(
    request: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown>;
}
