/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';

import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {MCPSessionManager} from './mcp_session_manager.js';

/**
 * Represents a tool exposed via the Model Context Protocol (MCP).
 *
 * This class acts as a wrapper around a tool definition received from an MCP
 * server. It passes the MCP tool's JSON Schema directly to the LLM via
 * {@link FunctionDeclaration.parametersJsonSchema} — no lossy conversion.
 * This preserves full schema fidelity (enum, format, pattern, etc.) and
 * works with any LLM that reads standard JSON Schema, not just Gemini.
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
    return {
      name: this.mcpTool.name,
      description: this.mcpTool.description,
      parametersJsonSchema: this.mcpTool.inputSchema,
      responseJsonSchema: this.mcpTool.outputSchema,
    };
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const params = {name: this.mcpTool.name, arguments: request.args};

    try {
      const session = await this.mcpSessionManager.createSession();
      return (await session.callTool(params)) as CallToolResult;
    } catch {
      // Invalidate the cached session and retry once with a fresh connection.
      await this.mcpSessionManager.close();
      const session = await this.mcpSessionManager.createSession();
      return (await session.callTool(params)) as CallToolResult;
    }
  }
}
