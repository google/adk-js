/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {
  CallToolRequest,
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {base64Encode} from '../../utils/env_aware_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
import {
  BaseAuthenticatedTool,
  RunAsyncAuthenticatedToolRequest,
} from '../base_authenticated_tool.js';

import {mergeHeaders, resolveAuthConfig} from './mcp_auth_utils.js';
import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Options for the {@link MCPTool} constructor.
 */
export interface MCPToolOptions {
  /** The tool definition received from the MCP server. */
  mcpTool: Tool;
  /** The session manager used to reach the MCP server. */
  mcpSessionManager: MCPSessionManager;
  /**
   * The name of the tool on the MCP server, when `mcpTool.name` carries a
   * toolset prefix. Defaults to `mcpTool.name`.
   */
  originalName?: string;
  /**
   * The authentication configuration of the tool. When set, each call
   * resolves a credential first and sends it to the server as HTTP headers.
   * Give either this or `authScheme`, not both.
   */
  authConfig?: AuthConfig;
  /**
   * The auth scheme of the tool. With `authCredential` and `credentialKey`,
   * an alternative to `authConfig`.
   */
  authScheme?: AuthScheme;
  /** The raw credential for `authScheme`. Requires `authScheme`. */
  authCredential?: AuthCredential;
  /**
   * The key the credential is saved under in the credential service. Requires
   * `authScheme`. Defaults to a key derived from `authScheme` and
   * `authCredential`.
   */
  credentialKey?: string;
}

/**
 * Builds the HTTP headers that carry `credential` to the MCP server.
 *
 * OAuth2 access tokens and HTTP bearer tokens become an `Authorization:
 * Bearer` header, HTTP basic credentials an `Authorization: Basic` header,
 * and a token for any other HTTP scheme `Authorization: <scheme> <token>`.
 * HTTP `additionalHeaders` are added as well, and replace an auth header of
 * the same name in any casing. An API key is sent in the header
 * that `authScheme` names, which must be an `apiKey` scheme located in the
 * header.
 *
 * @param credential The resolved credential, if any.
 * @param authScheme The auth scheme of the tool, if any.
 * @return The headers to send, or `undefined` when there are none.
 * @throws If an API key credential has no header-located `apiKey` scheme
 *     with a header name.
 */
function getAuthHeaders(
  credential: AuthCredential | undefined,
  authScheme: AuthScheme | undefined,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.oauth2) {
    // An OAuth2 credential without a token yields no header, rather than
    // falling through to another credential field on the same object.
    const accessToken = credential.oauth2.accessToken;
    return accessToken ? {Authorization: `Bearer ${accessToken}`} : undefined;
  }

  if (credential.http) {
    // `credentials` can be missing on a credential the client sent back,
    // whatever the type says, so each read below is guarded.
    const {scheme, credentials, additionalHeaders} = credential.http;
    let headers: Record<string, string> | undefined;
    const lowerScheme = scheme.toLowerCase();
    if (lowerScheme === 'bearer' && credentials?.token) {
      headers = {Authorization: `Bearer ${credentials.token}`};
    } else if (lowerScheme === 'basic') {
      if (credentials?.username && credentials?.password) {
        const encoded = base64Encode(
          `${credentials.username}:${credentials.password}`,
        );
        headers = {Authorization: `Basic ${encoded}`};
      }
    } else if (credentials?.token) {
      headers = {Authorization: `${scheme} ${credentials.token}`};
    }
    return additionalHeaders
      ? mergeHeaders(headers, additionalHeaders)
      : headers;
  }

  if (credential.apiKey) {
    if (authScheme?.type !== 'apiKey') {
      throw new Error(
        `MCPTool needs an apiKey auth scheme to send an API key credential, but the auth scheme type is '${authScheme?.type}'.`,
      );
    }
    if (authScheme.in !== 'header') {
      throw new Error(
        `MCPTool only supports header-based API key authentication. Configured location: '${authScheme.in}'.`,
      );
    }
    if (!authScheme.name?.trim()) {
      throw new Error(
        'MCPTool needs a header name in the apiKey auth scheme to send an API key credential.',
      );
    }
    return {[authScheme.name]: credential.apiKey};
  }

  if (credential.serviceAccount) {
    logger.warn(
      'Service account credentials should be exchanged before MCP session creation.',
    );
  }
  return undefined;
}

/**
 * Represents a tool exposed via the Model Context Protocol (MCP).
 *
 * This class acts as a wrapper around a tool definition received from an MCP
 * server. It translates the MCP tool's schema into a format compatible with
 * the Gemini AI platform (FunctionDeclaration) and handles the remote
 * execution of the tool by communicating with the MCP server through an
 * {@link MCPSessionManager}.
 *
 * When an LLM decides to call this tool, the `runAsync` method will be
 * invoked, which in turn establishes an MCP session, sends a `callTool`
 * request with the provided arguments, and returns the result from the
 * remote tool.
 *
 * The originalName parameter allows the tool to track the native tool name
 * exposed by the MCP server. This is critical when the toolset applies a
 * prefix to tool names (e.g., for LLM namespace disambiguation), ensuring
 * the correct original name is used when executing on the server.
 *
 * Authentication is experimental. When the tool has an `authConfig`, each call
 * first resolves a credential, asking the client for one if none is available
 * yet. The credential is sent as HTTP headers on the session opened for that
 * call; stdio connections ignore them. API keys are supported only in a
 * header.
 */
export class MCPTool extends BaseAuthenticatedTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly originalName: string;

  /**
   * @param options The tool definition, session manager and optional
   *     authentication configuration.
   */
  constructor(options: MCPToolOptions);
  /**
   * @param mcpTool The tool definition received from the MCP server.
   * @param mcpSessionManager The session manager used to reach the server.
   * @param originalName The name of the tool on the server, when
   *     `mcpTool.name` carries a toolset prefix.
   */
  constructor(
    mcpTool: Tool,
    mcpSessionManager: MCPSessionManager,
    originalName?: string,
  );
  constructor(
    toolOrOptions: Tool | MCPToolOptions,
    mcpSessionManager?: MCPSessionManager,
    originalName?: string,
  ) {
    const options = toMCPToolOptions(
      toolOrOptions,
      mcpSessionManager,
      originalName,
    );
    super({
      name: options.mcpTool.name,
      description: options.mcpTool.description || '',
      authConfig: resolveAuthConfig(options, 'MCPTool'),
    });
    this.mcpTool = options.mcpTool;
    this.mcpSessionManager = options.mcpSessionManager;
    this.originalName = options.originalName || options.mcpTool.name;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.mcpTool.name,
      description: this.mcpTool.description,
      parameters: toGeminiSchema(this.mcpTool.inputSchema),
      // TODO: need revisit, refer to this
      // https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result
      response: toGeminiSchema(this.mcpTool.outputSchema),
    };
  }

  protected override async runAsyncImpl({
    args,
    toolContext,
    credential,
  }: RunAsyncAuthenticatedToolRequest): Promise<unknown> {
    const headers = getAuthHeaders(credential, this.authConfig?.authScheme);
    const session = await this.mcpSessionManager.createSession(headers);

    try {
      const callRequest: CallToolRequest = {} as CallToolRequest;
      callRequest.params = {name: this.originalName, arguments: args};
      const result = await session.callTool(
        callRequest.params,
        undefined,
        this.mcpSessionManager.getRequestOptions(toolContext.abortSignal),
      );
      return result as CallToolResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }
}

/**
 * Reports whether the constructor got the options form: one object argument
 * that carries `mcpTool`, with no positional session manager after it.
 */
function isMCPToolOptions(
  toolOrOptions: Tool | MCPToolOptions,
  mcpSessionManager: MCPSessionManager | undefined,
): toolOrOptions is MCPToolOptions {
  return (
    mcpSessionManager === undefined &&
    typeof toolOrOptions === 'object' &&
    toolOrOptions !== null &&
    'mcpTool' in toolOrOptions
  );
}

/**
 * Normalizes the two constructor forms of {@link MCPTool} into one options
 * object, and checks that the required fields are present in either form.
 */
function toMCPToolOptions(
  toolOrOptions: Tool | MCPToolOptions,
  mcpSessionManager: MCPSessionManager | undefined,
  originalName: string | undefined,
): MCPToolOptions {
  const options: Partial<MCPToolOptions> = isMCPToolOptions(
    toolOrOptions,
    mcpSessionManager,
  )
    ? toolOrOptions
    : {mcpTool: toolOrOptions, mcpSessionManager, originalName};
  if (typeof options.mcpTool?.name !== 'string') {
    throw new Error('MCPTool needs an MCP tool definition with a name.');
  }
  if (!options.mcpSessionManager) {
    throw new Error(
      `MCPTool '${options.mcpTool.name}' needs an MCPSessionManager.`,
    );
  }
  return {
    ...options,
    mcpTool: options.mcpTool,
    mcpSessionManager: options.mcpSessionManager,
  };
}
