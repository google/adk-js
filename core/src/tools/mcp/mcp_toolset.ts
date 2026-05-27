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
 * It can also be configured with a prefix. If provided, all tools discovered
 * from the MCP server will have their names prefixed with `${prefix}_`. When the
 * LLM invokes the prefixed tool, this toolset transparently strips the prefix
 * before sending the request to the underlying MCP server.
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
    toolFilter: ToolPredicate | string[] = [],
    prefix?: string,
  ) {
    super(toolFilter, prefix);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const session = await this.mcpSessionManager.createSession();

    const listResult = (await session.listTools()) as ListToolsResult;
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

    // Apply toolFilter when specified.
    // An empty array (the default) means no filter — all tools are returned.
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }

    if (Array.isArray(filter)) {
      // String-array filter: match against the (possibly-prefixed) tool name.
      return tools.filter((tool) => (filter as string[]).includes(tool.name));
    }

    if (context) {
      // Predicate filter: requires a ReadonlyContext to evaluate.
      return tools.filter((tool) => filter(tool, context));
    }

    // Predicate filter requested but no context provided — return all tools
    // and log a warning so callers are aware the filter was not applied.
    logger.warn(
      'MCPToolset: a ToolPredicate toolFilter was provided but getTools() ' +
        'was called without a ReadonlyContext. The filter will not be applied.',
    );
    return tools;
  }

  async close(): Promise<void> {}
}
