/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {AuthCredentialTypes} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

const GOOGLE_API_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.googleApiTool');

/**
 * Type guard to check if an object is an instance of {@link GoogleApiTool}.
 */
export function isGoogleApiTool(obj: unknown): obj is GoogleApiTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_API_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_API_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Wraps a {@link RestApiTool} created from a Google API specification and adds
 * helper methods for configuring Google OpenID Connect credentials.
 */
@experimental
export class GoogleApiTool extends BaseTool {
  readonly [GOOGLE_API_TOOL_SIGNATURE_SYMBOL] = true;
  readonly restApiTool: RestApiTool;

  constructor(restApiTool: RestApiTool) {
    super({
      name: restApiTool.name,
      description: restApiTool.description,
      isLongRunning: restApiTool.isLongRunning,
    });
    this.restApiTool = restApiTool;
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    return this.restApiTool._getDeclaration();
  }

  @experimental
  override runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.restApiTool.runAsync(request);
  }

  /**
   * Configures OpenID Connect OAuth2 client credentials on the underlying
   * {@link RestApiTool}.
   */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.restApiTool.configureAuthCredential({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId,
        clientSecret,
      },
    });
  }
}
