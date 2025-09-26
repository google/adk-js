/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
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

  constructor(
      connectionParams: MCPConnectionParams,
      toolFilter: ToolPredicate|string[] = []) {
    super(toolFilter);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const session = await this.mcpSessionManager.createSession();

    const listResult = await session.listTools() as ListToolsResult;
    logger.debug(`number of tools: ${listResult.tools.length}`)
    for (const tool of listResult.tools) {
      logger.debug(`tool: ${tool.name}`)
    }

    // TODO: respect context (e.g. tool filter)
    return listResult.tools.map(
        (tool) => new MCPTool(tool, this.mcpSessionManager));
  }

  async close(): Promise<void> {}
}
