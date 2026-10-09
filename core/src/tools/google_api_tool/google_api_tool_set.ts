/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {OpenIdConnectWithConfig} from '../../auth/auth_schemes.js';
import {experimental} from '../../utils/experimental.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';
import {GoogleApiTool, isGoogleApiTool} from './google_api_tool.js';
import {GoogleApiToOpenApiConverter} from './googleapi_to_openapi_converter.js';

const GOOGLE_API_TOOL_SET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.googleApiToolSet',
);

const GOOGLE_OIDC_AUTH_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OIDC_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_OIDC_USERINFO_ENDPOINT =
  'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_OIDC_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * Options for constructing a {@link GoogleApiToolSet}.
 */
export interface GoogleApiToolSetOptions {
  apiName?: string;
  apiVersion?: string;
  toolFilter?: ToolPredicate | string[];
}

/**
 * Options for loading an {@link OpenAPIToolset} pre-configured with Google
 * OpenID Connect endpoints.
 */
export interface LoadToolSetWithOidcAuthOptions {
  specFile?: string;
  specDict?: OpenAPIV3.Document;
  scopes?: string[];
  callerDir?: string;
}

/**
 * Type guard to check if an object is an instance of {@link GoogleApiToolSet}.
 */
export function isGoogleApiToolSet(obj: unknown): obj is GoogleApiToolSet {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_API_TOOL_SET_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[GOOGLE_API_TOOL_SET_SIGNATURE_SYMBOL] ===
      true
  );
}

/**
 * Toolset that wraps Google Discovery API operations as {@link GoogleApiTool}
 * instances configured for Google OpenID Connect authentication.
 */
@experimental
export class GoogleApiToolSet extends BaseToolset {
  readonly [GOOGLE_API_TOOL_SET_SIGNATURE_SYMBOL] = true;
  readonly apiName?: string;
  readonly apiVersion?: string;
  private tools: GoogleApiTool[];
  private toolsLoaded: boolean;
  private loadingPromise?: Promise<void>;
  private pendingAuth?: {clientId: string; clientSecret: string};

  constructor(
    tools?: Array<RestApiTool | GoogleApiTool>,
    options: GoogleApiToolSetOptions = {},
  ) {
    super(options.toolFilter ?? []);
    this.apiName = options.apiName;
    this.apiVersion = options.apiVersion;

    if (tools !== undefined) {
      this.tools = tools.map((tool) =>
        isGoogleApiTool(tool) ? tool : new GoogleApiTool(tool),
      );
      this.toolsLoaded = true;
    } else {
      this.tools = [];
      this.toolsLoaded = false;
    }
  }

  private async ensureToolsLoaded(): Promise<void> {
    if (this.toolsLoaded || !this.apiName || !this.apiVersion) {
      return;
    }
    if (!this.loadingPromise) {
      const apiName = this.apiName;
      const apiVersion = this.apiVersion;
      this.loadingPromise = (async () => {
        try {
          const loaded = await GoogleApiToolSet.loadToolSet(
            apiName,
            apiVersion,
          );
          this.tools = loaded.tools;
          if (this.pendingAuth) {
            for (const tool of this.tools) {
              tool.configureAuth(
                this.pendingAuth.clientId,
                this.pendingAuth.clientSecret,
              );
            }
          }
          this.toolsLoaded = true;
        } finally {
          this.loadingPromise = undefined;
        }
      })();
    }
    await this.loadingPromise;
  }

  /**
   * Returns all tools in the toolset matching the active `toolFilter`.
   */
  @experimental
  override async getTools(context?: ReadonlyContext): Promise<GoogleApiTool[]> {
    await this.ensureToolsLoaded();
    return this.tools.filter((tool) =>
      this.isToolSelected(tool, context as ReadonlyContext),
    );
  }

  /**
   * Finds a tool in the toolset by name.
   */
  @experimental
  async getTool(toolName: string): Promise<GoogleApiTool | undefined> {
    await this.ensureToolsLoaded();
    return this.tools.find((tool) => tool.name === toolName);
  }

  /**
   * Configures OAuth2 client ID and secret across all tools in the toolset.
   */
  @experimental
  configureAuth(clientId: string, clientSecret: string): void {
    this.pendingAuth = {clientId, clientSecret};
    for (const tool of this.tools) {
      tool.configureAuth(clientId, clientSecret);
    }
  }

  @experimental
  override async close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Builds an {@link OpenAPIToolset} from an OpenAPI specification dictionary
   * or YAML/JSON file and configures it with Google's OpenID Connect endpoints.
   */
  @experimental
  static loadToolSetWithOidcAuth(
    options: LoadToolSetWithOidcAuthOptions = {},
  ): OpenAPIToolset {
    let specStr: string | undefined;
    if (options.specFile) {
      const dir = options.callerDir ?? process.cwd();
      const yamlPath = path.isAbsolute(options.specFile)
        ? options.specFile
        : path.join(dir, options.specFile);
      specStr = fs.readFileSync(yamlPath, 'utf-8');
    }

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
      scopes: options.scopes,
    };

    return new OpenAPIToolset({
      specDict: options.specDict,
      specStr,
      specType: 'yaml',
      authScheme,
    });
  }

  /**
   * Fetches and converts a Google API Discovery document and returns a
   * {@link GoogleApiToolSet} containing its operations.
   */
  @experimental
  static async loadToolSet(
    apiName: string,
    apiVersion: string,
  ): Promise<GoogleApiToolSet> {
    const specDict = await new GoogleApiToOpenApiConverter(
      apiName,
      apiVersion,
    ).convert();
    const oauth2Scheme = specDict.components?.securitySchemes?.['oauth2'] as
      OpenAPIV3.OAuth2SecurityScheme | undefined;
    const scopesMap = oauth2Scheme?.flows?.authorizationCode?.scopes ?? {};
    const firstScope = Object.keys(scopesMap)[0];
    const scopes = firstScope ? [firstScope] : undefined;

    const openapiToolset = this.loadToolSetWithOidcAuth({
      specDict,
      scopes,
    });
    const tools = (await openapiToolset.getTools()) as RestApiTool[];
    return new this(tools, {apiName, apiVersion});
  }
}

/**
 * Creates a lazy-loaded {@link GoogleApiToolSet} singleton without triggering
 * the `@experimental` class constructor warning at module import time.
 */
export function createLazyGoogleApiToolSet(
  apiName: string,
  apiVersion: string,
): GoogleApiToolSet {
  const BaseConstructor = Object.getPrototypeOf(
    GoogleApiToolSet,
  ) as typeof GoogleApiToolSet;
  return Reflect.construct(
    BaseConstructor,
    [undefined, {apiName, apiVersion}],
    GoogleApiToolSet,
  );
}
