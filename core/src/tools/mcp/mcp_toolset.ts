/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';

import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

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
 * Usage:
 *   import { MCPToolset } from '@google/adk';
 *   import { StreamableHTTPConnectionParamsSchema } from '@google/adk';
 *
 *   const connectionParams = StreamableHTTPConnectionParamsSchema.parse({
 *     type: "StreamableHTTPConnectionParams",
 *     url: "http://localhost:8788/mcp"
 *   });
 *
 *   const mcpToolset = new MCPToolset(connectionParams);
 *   const tools = await mcpToolset.getTools();
 *
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  private _cachedTools: BaseTool[] | null = null;

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
  ) {
    super(toolFilter);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  /**
   * Returns the tools exposed by the MCP server.
   *
   * The tool list is fetched from the server on the first call and then cached
   * for the lifetime of this toolset, so repeated calls across agent loop
   * iterations do not incur additional MCP round-trips. Call {@link close} to
   * invalidate the cache and allow re-discovery on the next call.
   */
  async getTools(): Promise<BaseTool[]> {
    if (this._cachedTools) {
      return this._cachedTools;
    }

    const session = await this.mcpSessionManager.createSession();

    const listResult = (await session.listTools()) as ListToolsResult;
    logger.debug(`number of tools: ${listResult.tools.length}`);
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`);
    }

    // TODO: respect context (e.g. tool filter)
    this._cachedTools = listResult.tools.map(
      (tool) => new MCPTool(tool, this.mcpSessionManager),
    );
    return this._cachedTools;
  }

  /**
   * Returns the server-level instructions string that the MCP server
   * advertises during the initialization handshake, or `undefined` if the
   * server did not provide any.
   *
   * These instructions are intended to be injected into the agent's system
   * prompt so the LLM understands how to best use this server's tools.
   * Inject them via the agent's `instruction` field:
   *
   * ```ts
   * const toolset = new MCPToolset(params);
   * const agent = new LlmAgent({
   *   instruction: async () => (await toolset.getServerInstructions()) ?? '',
   *   tools: [toolset],
   * });
   * ```
   */
  async getServerInstructions(): Promise<string | undefined> {
    const session = await this.mcpSessionManager.createSession();
    return session.getInstructions();
  }

  async close(): Promise<void> {
    this._cachedTools = null;
    await this.mcpSessionManager.close();
  }
}
