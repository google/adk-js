/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {CallToolRequest, CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';

import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {BaseTool, RunToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

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
 */
export class MCPTool extends BaseTool {
  private readonly mcpTool: Tool;
  private readonly mcpSessionManager: MCPSessionManager;

  constructor(mcpTool: Tool, mcpSessionManager: MCPSessionManager) {
    super({name: mcpTool.name, description: mcpTool.description || ''});
    this.mcpTool = mcpTool;
    this.mcpSessionManager = mcpSessionManager;
  }

  override _getDeclaration(): FunctionDeclaration {
    let declaration: FunctionDeclaration;
    declaration = {
      name: this.mcpTool.name,
      description: this.mcpTool.description,
      parameters: toGeminiSchema(this.mcpTool.inputSchema),
      // TODO: need revisit, refer to this
      // https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result
      response: toGeminiSchema(this.mcpTool.outputSchema),
    };
    return declaration;
  }

  override async runAsync(request: RunToolRequest): Promise<unknown> {
    const session = await this.mcpSessionManager.createSession();

    const callRequest: CallToolRequest = {} as CallToolRequest;
    callRequest.params = {name: this.mcpTool.name, arguments: request.args};

    return await session.callTool(callRequest.params) as CallToolResult;
  }
}
