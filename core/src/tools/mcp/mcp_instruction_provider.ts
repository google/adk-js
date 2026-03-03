/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GetPromptResult} from '@modelcontextprotocol/sdk/types.js';

import {InstructionProvider} from '../../agents/llm_agent.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';

import {MCPConnectionParams, MCPSessionManager} from './mcp_session_manager.js';

/**
 * Parameters for {@link createMcpInstructionProvider}.
 */
export interface McpInstructionProviderParams {
  /** Connection parameters for the MCP server. */
  connectionParams: MCPConnectionParams;
  /**
   * The name of the MCP Prompt to fetch on each invocation.
   * The server must expose this prompt via `listPrompts`.
   */
  promptName: string;
}

/**
 * Creates an {@link InstructionProvider} that fetches a named
 * {@link https://modelcontextprotocol.io/specification/2025-06-18/server/prompts | MCP Prompt}
 * from an MCP server and returns it as the agent's instruction string.
 *
 * This mirrors the Python ADK `McpInstructionProvider`. The prompt is
 * re-fetched on every agent invocation so it can incorporate dynamic
 * context — prompt arguments are automatically populated from matching keys
 * in `context.state`.
 *
 * Usage:
 * ```ts
 * const agent = new LlmAgent({
 *   instruction: createMcpInstructionProvider({
 *     connectionParams: { type: 'StreamableHTTPConnectionParams', url: '...' },
 *     promptName: 'agent_instructions',
 *   }),
 *   tools: [toolset],
 * });
 * ```
 */
export function createMcpInstructionProvider(
  params: McpInstructionProviderParams,
): InstructionProvider {
  const manager = new MCPSessionManager(params.connectionParams);

  return async (context: ReadonlyContext): Promise<string> => {
    const session = await manager.createSession();

    const listResult = await session.listPrompts();
    const promptDef = listResult.prompts.find(
      (p) => p.name === params.promptName,
    );

    if (!promptDef) {
      throw new Error(
        `MCP prompt '${params.promptName}' not found on server. ` +
          `Available: ${listResult.prompts.map((p) => p.name).join(', ') || '(none)'}`,
      );
    }

    const promptArgs: Record<string, string> = {};
    if (promptDef.arguments && context.state) {
      for (const arg of promptDef.arguments) {
        const value = context.state[arg.name];
        if (value !== undefined) {
          promptArgs[arg.name] = String(value);
        }
      }
    }

    const result: GetPromptResult = await session.getPrompt({
      name: params.promptName,
      arguments: promptArgs,
    });

    if (!result?.messages?.length) {
      throw new Error(
        `MCP prompt '${params.promptName}' returned no messages.`,
      );
    }

    return result.messages
      .filter((m) => m.content.type === 'text')
      .map((m) => (m.content as {type: 'text'; text: string}).text)
      .join('\n');
  };
}
