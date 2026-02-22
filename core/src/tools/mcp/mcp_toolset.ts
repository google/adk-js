/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest, appendInstructions} from '../../models/llm_request.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {ToolContext} from '../tool_context.js';

import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';
import {MCPTool} from './mcp_tool.js';

/**
 * A toolset that dynamically discovers and provides tools from a Model Context
 * Protocol (MCP) server.
 *
 * This class connects to an MCP server, retrieves the list of available tools,
 * and wraps each of them in an {@link MCPTool} instance. Tools and the
 * underlying session are cached after the first discovery call, following the
 * MCP spec's "list once, refresh on notification" pattern.
 *
 * The toolset can be configured with a filter to selectively expose a subset
 * of the tools provided by the MCP server.
 *
 * MCP server instructions (provided during the `initialize` handshake) are
 * automatically read and appended to the LLM system prompt via
 * {@link processLlmRequest}.
 *
 * Usage:
 *   import { MCPToolset } from '@google/adk';
 *
 *   const mcpToolset = new MCPToolset({
 *     type: 'StreamableHTTPConnectionParams',
 *     url: 'http://localhost:8788/mcp',
 *   });
 *
 *   const agent = new LlmAgent({
 *     name: 'mcp_agent',
 *     model: 'gemini-2.5-flash',
 *     tools: [mcpToolset],
 *   });
 */
export class MCPToolset extends BaseToolset {
  private readonly mcpSessionManager: MCPSessionManager;
  private cachedTools?: BaseTool[];

  constructor(
    connectionParams: MCPConnectionParams,
    toolFilter: ToolPredicate | string[] = [],
  ) {
    super(toolFilter);
    this.mcpSessionManager = new MCPSessionManager(connectionParams);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!this.cachedTools) {
      const session = await this.mcpSessionManager.createSession();
      const listResult = (await session.listTools()) as ListToolsResult;
      logger.debug(`number of tools: ${listResult.tools.length}`);
      for (const tool of listResult.tools) {
        logger.debug(`tool: ${tool.name}`);
      }
      this.cachedTools = listResult.tools.map(
        (tool) => new MCPTool(tool, this.mcpSessionManager),
      );
    }

    if (!context) return [...this.cachedTools];

    const hasFilter =
      typeof this.toolFilter === 'function' ||
      (Array.isArray(this.toolFilter) && this.toolFilter.length > 0);
    if (!hasFilter) return [...this.cachedTools];

    return this.cachedTools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Appends MCP server instructions to the LLM system prompt.
   *
   * Instructions are wrapped in `<mcp_instructions>` XML tags so the LLM
   * can distinguish them from the agent's own instructions. This follows
   * the pattern used by Claude and Cursor where structured XML tags help
   * the model parse distinct sections of a composite system prompt.
   *
   * Called once per agent step. Since LLM APIs are stateless, the system
   * instruction must be present in every request — this is not duplication
   * but a requirement of the generate-content protocol. The instructions
   * string itself is cached in {@link MCPSessionManager} (fetched once
   * during the `initialize` handshake) so the cost here is a single
   * string concatenation per step.
   */
  override async processLlmRequest(
    _toolContext: ToolContext,
    llmRequest: LlmRequest,
  ): Promise<void> {
    const instructions = this.mcpSessionManager.getInstructions();
    if (instructions) {
      const tagged =
        '<mcp_instructions>\n' + instructions + '\n</mcp_instructions>';
      appendInstructions(llmRequest, [tagged]);
    }
  }

  async close(): Promise<void> {
    this.cachedTools = undefined;
    await this.mcpSessionManager.close();
  }
}
