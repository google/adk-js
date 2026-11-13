/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {resolveAuthConfig} from './mcp_auth_utils.js';
import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

export type {
  SseConnectionParams,
  SseServerParams,
} from './mcp_session_manager.js';

/**
 * Options for the {@link MCPToolset} constructor.
 */
export interface MCPToolsetOptions {
  /** How to connect to the MCP server. */
  connectionParams: MCPConnectionParams;
  /** Restricts which tools reach the model, by name or predicate. */
  toolFilter?: ToolPredicate | string[];
  /** Prefixes every discovered tool name with `${prefix}_`. */
  prefix?: string;
  /**
   * The authentication configuration given to every discovered
   * {@link MCPTool}. It applies to tool calls only, not to tool discovery or
   * resource reads. Give either this or `authScheme`, not both.
   */
  authConfig?: AuthConfig;
  /**
   * The auth scheme given to every discovered {@link MCPTool}. With
   * `authCredential` and `credentialKey`, an alternative to `authConfig`.
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

function isMCPToolsetOptions(
  arg: MCPConnectionParams | MCPToolsetOptions,
): arg is MCPToolsetOptions {
  return typeof arg === 'object' && arg !== null && 'connectionParams' in arg;
}

/**
 * A toolset that dynamically discovers and provides tools from a Model Context
 * Protocol (MCP) server.
 *
 * This class connects to an MCP server, retrieves the list of available tools,
 * and wraps each of them in an {@link MCPTool} instance. This allows the agent
 * to seamlessly use tools from an external MCP-compliant service.
 *
 * The toolset can be configured with a filter to selectively expose a subset
 * of the tools provided by the MCP server.
 *
 * It can also be configured with a prefix. If provided, all tools discovered
 * from the MCP server will have their names prefixed with `${prefix}_`. When the
 * LLM invokes the prefixed tool, this toolset transparently strips the prefix
 * before sending the request to the underlying MCP server.
 *
 * @example
 * ```ts
 * import {MCPToolset} from '@google/adk';
 * import type {StreamableHTTPConnectionParams} from '@google/adk';
 *
 * const connectionParams: StreamableHTTPConnectionParams = {
 *   type: 'StreamableHTTPConnectionParams',
 *   url: 'http://localhost:8788/mcp',
 * };
 *
 * const mcpToolset = new MCPToolset(connectionParams);
 * const tools = await mcpToolset.getTools();
 * ```
 *
 * @example
 * ```ts
 * import {MCPToolset} from '@google/adk';
 * import type {SseConnectionParams} from '@google/adk';
 *
 * const sseParams: SseConnectionParams = {
 *   type: 'SseConnectionParams',
 *   url: 'http://localhost:8090/sse',
 * };
 *
 * const sseToolset = new MCPToolset(sseParams);
 * const sseTools = await sseToolset.getTools();
 * ```
 *
 * @example
 * ```ts
 * import {AuthCredentialTypes, MCPToolset} from '@google/adk';
 *
 * const authToolset = new MCPToolset({
 *   connectionParams: {
 *     type: 'StreamableHTTPConnectionParams',
 *     url: 'http://localhost:8788/mcp',
 *   },
 *   authConfig: {
 *     authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
 *     rawAuthCredential: {
 *       authType: AuthCredentialTypes.API_KEY,
 *       apiKey: process.env.MCP_API_KEY,
 *     },
 *     credentialKey: 'mcp-api-key',
 *   },
 * });
 * ```
 *
 * Instead of `authConfig`, the options can give `authScheme`, an optional
 * `authCredential` and an optional `credentialKey`.
 *
 * Authentication is experimental. With an `authConfig`, each tool call sends
 * the resolved credential as HTTP headers; see {@link MCPTool}.
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly authConfig?: AuthConfig;

  /**
   * @param options The connection parameters, tool filter, prefix and
   *     optional authentication configuration.
   */
  constructor(options: MCPToolsetOptions);
  /**
   * @param connectionParams How to connect to the MCP server.
   * @param toolFilter Restricts which tools reach the model, by name or
   *     predicate.
   * @param prefix Prefixes every discovered tool name with `${prefix}_`.
   */
  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter?: ToolPredicate | string[],
    prefix?: string,
  );
  constructor(
    paramsOrOptions: MCPConnectionParams | MCPToolsetOptions,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    const options = isMCPToolsetOptions(paramsOrOptions)
      ? paramsOrOptions
      : {connectionParams: paramsOrOptions, toolFilter, prefix};
    if (!options.connectionParams) {
      throw new Error('MCPToolset needs connectionParams.');
    }
    super(options.toolFilter ?? [], options.prefix);
    this.mcpSessionManager = new MCPSessionManager(options.connectionParams);
    this.authConfig = resolveAuthConfig(options, 'MCPToolset');
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const session = await this.mcpSessionManager.createSession();

    let listResult: ListToolsResult;
    try {
      listResult = (await session.listTools(
        undefined,
        this.mcpSessionManager.getRequestOptions(),
      )) as ListToolsResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
    logger.debug(`number of tools: ${listResult.tools.length}`);
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`);
    }

    const tools = listResult.tools.map((tool) => {
      // Create a cloned tool definition with the prefixed name
      const toolWithPrefix = {
        ...tool,
        name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      };
      return new MCPTool({
        mcpTool: toolWithPrefix,
        mcpSessionManager: this.mcpSessionManager,
        originalName: tool.name,
        authConfig: this.authConfig,
      });
    });

    return tools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @return The resource names available on the server.
   */
  async listResources(): Promise<string[]> {
    const session = await this.mcpSessionManager.createSession();
    try {
      const result = (await session.listResources(
        undefined,
        this.mcpSessionManager.getRequestOptions(),
      )) as ListResourcesResult;
      return result.resources.map((resource) => resource.name);
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const session = await this.mcpSessionManager.createSession();
    let result: ListResourcesResult;
    try {
      result = (await session.listResources(
        undefined,
        this.mcpSessionManager.getRequestOptions(),
      )) as ListResourcesResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }

    const resource = result.resources.find(
      (candidate) => candidate.name === name,
    );
    if (!resource) {
      throw new Error(`Resource with name '${name}' not found.`);
    }
    return resource;
  }

  /**
   * Reads the contents of the named resource from the MCP server.
   *
   * The resource name is resolved to a URI via {@link getResourceInfo} before
   * reading. Binary contents are returned base64-encoded, exactly as provided
   * by the server (never decoded and re-encoded).
   *
   * @param name The advertised name of the resource to read.
   * @return The resource contents (text and/or base64-encoded binary).
   * @throws If the resource is unknown or has no URI.
   */
  async readResource(
    name: string,
  ): Promise<Array<TextResourceContents | BlobResourceContents>> {
    const resourceInfo = await this.getResourceInfo(name);
    if (!resourceInfo.uri) {
      throw new Error(`Resource '${name}' has no URI.`);
    }

    const session = await this.mcpSessionManager.createSession();
    try {
      const result = (await session.readResource(
        {
          uri: resourceInfo.uri,
        },
        this.mcpSessionManager.getRequestOptions(),
      )) as ReadResourceResult;
      return result.contents;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }
  }

  async close(): Promise<void> {
    const sessions = this.mcpSessionManager.getActiveSessions();
    await Promise.allSettled(
      sessions.map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}
