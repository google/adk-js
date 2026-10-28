/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {OpenIdConnectWithConfig} from '../../auth/auth_schemes.js';
import {experimental} from '../../utils/experimental.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';
import {GoogleApiTool} from './google_api_tool.js';
import {GoogleApiToOpenApiConverter} from './googleapi_to_openapi_converter.js';

const GOOGLE_API_TOOLSET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.googleApiToolset',
);

const GOOGLE_OIDC_AUTH_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OIDC_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_OIDC_USERINFO_ENDPOINT =
  'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_OIDC_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * Options for constructing a {@link GoogleApiToolset}.
 */
export interface GoogleApiToolsetOptions {
  apiName?: string;
  apiVersion?: string;
  clientId?: string;
  clientSecret?: string;
  toolFilter?: ToolPredicate | string[];
}

/**
 * Type guard to check if an object is an instance of {@link GoogleApiToolset}.
 */
export function isGoogleApiToolset(obj: unknown): obj is GoogleApiToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_API_TOOLSET_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_API_TOOLSET_SIGNATURE_SYMBOL] ===
      true
  );
}

/**
 * Toolset that wraps Google Discovery API operations as {@link GoogleApiTool}
 * instances configured for Google OpenID Connect authentication.
 */
@experimental
export class GoogleApiToolset extends BaseToolset {
  readonly [GOOGLE_API_TOOLSET_SIGNATURE_SYMBOL] = true;
  override toolFilter: ToolPredicate | string[];
  readonly apiName?: string;
  readonly apiVersion?: string;
  private clientId?: string;
  private clientSecret?: string;
  private openapiToolset?: OpenAPIToolset;
  private loadingPromise?: Promise<void>;
  private tools: GoogleApiTool[] = [];

  constructor(options: GoogleApiToolsetOptions = {}) {
    const toolFilter = options.toolFilter ?? [];
    super(toolFilter);
    this.toolFilter = toolFilter;
    this.apiName = options.apiName;
    this.apiVersion = options.apiVersion;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  private async loadToolsetWithOidcAuth(): Promise<OpenAPIToolset> {
    if (!this.apiName || !this.apiVersion) {
      throw new Error(
        'Both apiName and apiVersion are required to load a GoogleApiToolset.',
      );
    }
    const specDict = await new GoogleApiToOpenApiConverter(
      this.apiName,
      this.apiVersion,
    ).convert();
    const oauth2Scheme = specDict.components?.securitySchemes?.['oauth2'] as
      OpenAPIV3.OAuth2SecurityScheme | undefined;
    const scopesMap = oauth2Scheme?.flows?.authorizationCode?.scopes ?? {};
    const firstScope = Object.keys(scopesMap)[0];
    const scopes = firstScope ? [firstScope] : undefined;

    const authScheme: OpenIdConnectWithConfig = {
      type: 'openIdConnect',
      openIdConnectUrl: '',
      authorizationEndpoint: GOOGLE_OIDC_AUTH_ENDPOINT,
      tokenEndpoint: GOOGLE_OIDC_TOKEN_ENDPOINT,
      userinfoEndpoint: GOOGLE_OIDC_USERINFO_ENDPOINT,
      revocationEndpoint: GOOGLE_OIDC_REVOCATION_ENDPOINT,
      tokenEndpointAuthMethodsSupported: [
        'client_secret_post',
        'client_secret_basic',
      ],
      grantTypesSupported: ['authorization_code'],
      scopes,
    };

    return new OpenAPIToolset({
      specDict,
      specType: 'yaml',
      authScheme,
    });
  }

  private async ensureToolsLoaded(): Promise<void> {
    if (this.openapiToolset || !this.apiName || !this.apiVersion) {
      return;
    }
    this.loadingPromise ??= (async () => {
      try {
        const openapiToolset = await this.loadToolsetWithOidcAuth();
        const restTools = (await openapiToolset.getTools()) as RestApiTool[];
        this.tools = restTools.map(
          (tool) =>
            new GoogleApiTool(tool, {
              clientId: this.clientId,
              clientSecret: this.clientSecret,
            }),
        );
        this.openapiToolset = openapiToolset;
      } catch (error: unknown) {
        this.loadingPromise = undefined;
        throw error;
      }
    })();
    await this.loadingPromise;
  }

  /**
   * Returns all tools in the toolset matching the active `toolFilter`.
   */
  @experimental
  override async getTools(context?: ReadonlyContext): Promise<GoogleApiTool[]> {
    await this.ensureToolsLoaded();
    return this.tools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Updates the tool filter used by {@link getTools}.
   */
  @experimental
  setToolFilter(toolFilter: ToolPredicate | string[]): void {
    this.toolFilter = toolFilter;
  }

  /**
   * Configures OAuth2 client ID and secret across all tools in the toolset.
   */
  @experimental
  configureAuth(clientId?: string, clientSecret?: string): void {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    for (const tool of this.tools) {
      tool.configureAuth(clientId, clientSecret);
    }
  }

  @experimental
  override async close(): Promise<void> {
    if (this.openapiToolset) {
      await this.openapiToolset.close();
    }
  }
}
