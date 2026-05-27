/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {applyCredential} from './auth/auth_helpers.js';
import {OperationParser} from './openapi_spec_parser/operation_parser.js';
import {ToolAuthHandler} from './openapi_spec_parser/tool_auth_handler.js';

export interface OperationEndpoint {
  baseUrl: string;
  path: string;
  method: string;
}

@experimental
export class RestApiTool extends BaseTool {
  private operationParser: OperationParser;

  private headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  private credentialKey?: string;

  constructor(
    name: string,
    description: string,
    private readonly endpoint: OperationEndpoint,
    private readonly operation: OpenAPIV3.OperationObject,
    private authScheme?: OpenAPIV3.SecuritySchemeObject,
    private authCredential?: AuthCredential,
    options: {
      preservePropertyNames?: boolean;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
      credentialKey?: string;
    } = {},
  ) {
    super({name, description});
    this.authScheme = authScheme;
    this.authCredential = authCredential;
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;
    this.operationParser = new OperationParser(operation, options);
  }

  @experimental
  public configureAuthScheme(authScheme: OpenAPIV3.SecuritySchemeObject) {
    this.authScheme = authScheme;
  }

  @experimental
  public configureAuthCredential(authCredential: AuthCredential) {
    this.authCredential = authCredential;
  }

  @experimental
  public configureCredentialKey(credentialKey: string) {
    this.credentialKey = credentialKey;
  }

  @experimental
  public static fromParsedOperation(
    parsed: {
      name: string;
      description: string;
      endpoint: OperationEndpoint;
      operation: OpenAPIV3.OperationObject;
      authScheme?: OpenAPIV3.SecuritySchemeObject;
    },
    options: {
      preservePropertyNames?: boolean;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
      credentialKey?: string;
    } = {},
  ): RestApiTool {
    return new RestApiTool(
      parsed.name,
      parsed.description,
      parsed.endpoint,
      parsed.operation,
      parsed.authScheme,
      undefined, // Credential will be filled later or via context
      options,
    );
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const schema = this.operationParser.getJsonSchema();
    return {
      name: this.name,
      description: this.description,
      parameters: schema,
    };
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const context = request.toolContext as Context;
    const args = request.args;

    const authHandler = ToolAuthHandler.fromToolContext(
      context,
      this.authScheme,
      this.authCredential,
      {credentialKey: this.credentialKey},
    );

    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    const credential = authResult.authCredential;

    // Prepare request
    const method = this.endpoint.method.toUpperCase();
    let url = `${this.endpoint.baseUrl}${this.endpoint.path}`;

    const headers: Record<string, string> = {};

    const queryParams = new URLSearchParams();
    let body: unknown = undefined;

    const parameters = this.operationParser.getParameters();
    const paramsMap = new Map(parameters.map((p) => [p.name, p]));

    const pathParams: Record<string, string> = {};
    const bodyData: Record<string, unknown> = {};

    for (const [argName, argValue] of Object.entries(args)) {
      const param = paramsMap.get(argName);
      if (!param) continue;

      const originalName = param.originalName;
      const location = param.paramLocation;

      if (location === 'path') {
        pathParams[originalName] = String(argValue);
      } else if (location === 'query') {
        queryParams.append(originalName, String(argValue));
      } else if (location === 'header') {
        headers[originalName] = String(argValue);
      } else if (location === 'body') {
        if (
          originalName === 'body' ||
          originalName === 'array' ||
          originalName === ''
        ) {
          body = argValue;
        } else {
          bodyData[originalName] = argValue;
        }
      }
    }

    // Replace path parameters
    for (const [key, value] of Object.entries(pathParams)) {
      url = url.replace(`{${key}}`, value);
    }

    // Extract query parameters from path if any
    const urlParts = url.split('?');
    if (urlParts.length > 1) {
      const pathQueryParams = new URLSearchParams(urlParts[1]);
      for (const [key, value] of pathQueryParams.entries()) {
        queryParams.append(key, value);
      }
      url = urlParts[0];
    }

    // Append query parameters
    const queryString = queryParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    // Handle body
    const requestBody = this.operation.requestBody;
    const finalData =
      body !== undefined
        ? body
        : Object.keys(bodyData).length > 0
          ? bodyData
          : undefined;

    if (requestBody && 'content' in requestBody) {
      const content = requestBody.content;
      for (const [mimeType, _mediaTypeObject] of Object.entries(content)) {
        if (finalData !== undefined) {
          if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
            body =
              typeof finalData === 'string'
                ? finalData
                : JSON.stringify(finalData);
            headers['Content-Type'] = mimeType;
          } else if (mimeType === 'application/x-www-form-urlencoded') {
            body = new URLSearchParams(finalData as Record<string, string>);
            // Fetch sets content-type automatically for URLSearchParams
          } else if (mimeType === 'multipart/form-data') {
            const formData = new FormData();
            if (typeof finalData === 'object' && finalData !== null) {
              for (const [key, value] of Object.entries(finalData)) {
                formData.append(key, String(value));
              }
            }
            body = formData;
            // Fetch sets content-type with boundary automatically. DO NOT set it.
          } else if (mimeType === 'text/plain') {
            body = String(finalData);
            headers['Content-Type'] = mimeType;
          }
        }
        break; // Process only the first mime type
      }
    } else if (finalData !== undefined) {
      // Fallback to JSON if no requestBody content specified but data exists
      body =
        typeof finalData === 'string' ? finalData : JSON.stringify(finalData);
      headers['Content-Type'] = 'application/json';
    }

    // Handle Auth
    url = applyCredential(url, headers, credential, this.authScheme);

    // Apply dynamic headers from provider
    if (this.headerProvider) {
      const providerHeaders = this.headerProvider(context);
      Object.assign(headers, providerHeaders);
    }

    try {
      const response = await globalThis.fetch(url, {
        method,
        headers,
        // eslint-disable-next-line no-undef
        body: body as BodyInit,
      });

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      return {
        error: `Failed to execute API call: ${(error as Error).message}`,
      };
    }
  }
}
