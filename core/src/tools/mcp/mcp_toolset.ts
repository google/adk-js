/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import type {
  BlobResourceContents,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceResult,
  Resource,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {
  isDisconnectedSessionError,
  MCPConnectionParams,
  MCPSessionManager,
} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

export type {
  SseConnectionParams,
  SseServerParams,
} from './mcp_session_manager.js';

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
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    super(toolFilter, prefix);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  private async runOnceWithSession<T>(
    operation: (session: Client) => Promise<T>,
  ): Promise<T> {
    const session = await this.mcpSessionManager.getSession();
    this.mcpSessionManager.retainSession(session);
    try {
      return await operation(session);
    } catch (err) {
      if (isDisconnectedSessionError(err)) {
        await this.mcpSessionManager.closeSession(session).catch(() => {});
      }
      throw err;
    } finally {
      await this.mcpSessionManager.releaseSession(session);
    }
  }

  private async withSession<T>(
    operation: (session: Client) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runOnceWithSession(operation);
    } catch (err) {
      if (isDisconnectedSessionError(err)) {
        return await this.runOnceWithSession(operation);
      }
      throw err;
    }
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const listResult = await this.withSession(
      async (session) => (await session.listTools()) as ListToolsResult,
    );
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
      return new MCPTool(toolWithPrefix, this.mcpSessionManager, tool.name);
    });

    return tools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Lists the names of the resources advertised by the MCP server.
   *
   * @return The resource names available on the server.
   */
  async listResources(): Promise<string[]> {
    const result = await this.withSession(
      async (session) => (await session.listResources()) as ListResourcesResult,
    );
    return result.resources.map((resource) => resource.name);
  }

  /**
   * Returns metadata for the resource whose name matches `name`.
   *
   * @param name The advertised name of the resource.
   * @return The matching MCP `Resource`.
   * @throws If no resource with the given name is advertised by the server.
   */
  async getResourceInfo(name: string): Promise<Resource> {
    const result = await this.withSession(
      async (session) => (await session.listResources()) as ListResourcesResult,
    );

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

    const result = await this.withSession(
      async (session) =>
        (await session.readResource({
          uri: resourceInfo.uri,
        })) as ReadResourceResult,
    );
    return result.contents;
  }

  async close(): Promise<void> {
    await this.mcpSessionManager.close();
  }
}
