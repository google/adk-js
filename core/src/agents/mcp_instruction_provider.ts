/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GetPromptResult} from '@modelcontextprotocol/sdk/types.js';

import {
  MCPConnectionParams,
  MCPSessionManager,
} from '../tools/mcp/mcp_session_manager.js';

import type {InstructionProvider} from './llm_agent.js';
import type {ReadonlyContext} from './readonly_context.js';

const MCP_INSTRUCTION_PROVIDER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.mcpInstructionProvider',
);

/**
 * Arguments sent when requesting a prompt from an MCP server.
 *
 * May be either a fixed string mapping or a callback that selects arguments
 * from the current {@link ReadonlyContext}. Keeping argument selection explicit
 * ensures session state is never forwarded to an MCP server unless the caller
 * intentionally chooses the keys to send.
 */
export type McpPromptArguments =
  | Record<string, string>
  | ((
      context: ReadonlyContext,
    ) =>
      | Record<string, string>
      | undefined
      | Promise<Record<string, string> | undefined>);

/**
 * Options for constructing an {@link McpInstructionProvider}.
 */
export interface McpInstructionProviderOptions {
  /** Parameters for connecting to the MCP server. */
  connectionParams: MCPConnectionParams;
  /** Name of the MCP prompt to fetch via `prompts/get`. */
  promptName: string;
  /**
   * Optional arguments to send with the prompt request, either as a fixed
   * key-value mapping or as a callback that builds one from the current
   * {@link ReadonlyContext}. No arguments are sent when omitted or when the
   * callback returns `undefined`.
   */
  arguments?: McpPromptArguments;
}

/**
 * Type guard to check if an object is an instance of
 * {@link McpInstructionProvider}.
 */
export function isMcpInstructionProvider(
  obj: unknown,
): obj is McpInstructionProvider {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    MCP_INSTRUCTION_PROVIDER_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      MCP_INSTRUCTION_PROVIDER_SIGNATURE_SYMBOL
    ] === true
  );
}

/**
 * Fetches agent instructions from a named prompt on a Model Context Protocol
 * (MCP) server.
 *
 * Call {@link asInstructionProvider} (or use
 * {@link createMcpInstructionProvider}) to pass this provider directly to
 * `LlmAgent.instruction` or `GlobalInstructionPlugin`.
 *
 * @example
 * ```ts
 * import {createMcpInstructionProvider, LlmAgent} from '@google/adk';
 *
 * const agent = new LlmAgent({
 *   name: 'support_agent',
 *   model: 'gemini-2.5-flash',
 *   instruction: createMcpInstructionProvider({
 *     connectionParams: {
 *       type: 'StreamableHTTPConnectionParams',
 *       url: 'http://localhost:8788/mcp',
 *     },
 *     promptName: 'customer_support',
 *     arguments: (ctx) => ({
 *       locale: String(ctx.state.get('locale') ?? 'en-US'),
 *     }),
 *   }),
 * });
 * ```
 */
export class McpInstructionProvider {
  readonly [MCP_INSTRUCTION_PROVIDER_SIGNATURE_SYMBOL] = true;
  readonly promptName: string;
  private readonly mcpSessionManager: MCPSessionManager;
  private readonly promptArguments?: McpPromptArguments;

  constructor(options: McpInstructionProviderOptions) {
    if (!options?.connectionParams) {
      throw new Error('McpInstructionProvider requires connectionParams.');
    }
    if (!options.promptName || options.promptName.trim() === '') {
      throw new Error(
        'McpInstructionProvider requires a non-empty promptName.',
      );
    }

    this.promptName = options.promptName;
    this.promptArguments = options.arguments;
    this.mcpSessionManager = new MCPSessionManager(options.connectionParams);
  }

  /**
   * Fetches the configured prompt from the MCP server and concatenates all
   * text message contents into a single instruction string.
   *
   * Only arguments explicitly supplied through
   * {@link McpInstructionProviderOptions.arguments} are sent to the server.
   * Session state is never inspected or forwarded automatically.
   *
   * @param context The readonly context for the current invocation.
   * @return The concatenated instruction text from the prompt messages.
   * @throws If the MCP server returns no prompt messages.
   */
  async getInstruction(context: ReadonlyContext): Promise<string> {
    // The caller decides what is sent. Server-declared argument names are not
    // consulted, so an MCP server cannot choose which session state values it
    // receives.
    const rawArguments =
      typeof this.promptArguments === 'function'
        ? await this.promptArguments(context)
        : this.promptArguments;
    const resolvedArguments =
      rawArguments !== undefined ? {...rawArguments} : undefined;

    const session = await this.mcpSessionManager.createSession();
    let promptResult: GetPromptResult;
    try {
      const requestParams =
        resolvedArguments !== undefined
          ? {name: this.promptName, arguments: resolvedArguments}
          : {name: this.promptName};
      promptResult = (await session.getPrompt(
        requestParams,
        this.mcpSessionManager.getRequestOptions(
          context?.invocationContext?.abortSignal,
        ),
      )) as GetPromptResult;
    } finally {
      await this.mcpSessionManager.closeSession(session);
    }

    if (!promptResult?.messages || promptResult.messages.length === 0) {
      throw new Error(`Failed to load MCP prompt '${this.promptName}'.`);
    }

    return promptResult.messages
      .filter(
        (
          message,
        ): message is typeof message & {
          content: {type: 'text'; text: string};
        } =>
          message.content?.type === 'text' &&
          typeof message.content.text === 'string',
      )
      .map((message) => message.content.text)
      .join('');
  }

  /**
   * Returns an {@link InstructionProvider} function bound to this provider for
   * direct use in `LlmAgent.instruction` or `GlobalInstructionPlugin`.
   */
  asInstructionProvider(): InstructionProvider {
    return (context: ReadonlyContext) => this.getInstruction(context);
  }

  /**
   * Closes any active MCP client sessions opened by this provider.
   */
  async close(): Promise<void> {
    await Promise.all(
      this.mcpSessionManager
        .getActiveSessions()
        .map((session) => this.mcpSessionManager.closeSession(session)),
    );
  }
}

/**
 * Creates an {@link InstructionProvider} function backed by an
 * {@link McpInstructionProvider}.
 *
 * @param options Connection parameters, prompt name, and optional prompt
 *     arguments.
 * @return An {@link InstructionProvider} function that fetches the prompt from
 *     the MCP server on each invocation.
 */
export function createMcpInstructionProvider(
  options: McpInstructionProviderOptions,
): InstructionProvider {
  const provider = new McpInstructionProvider(options);
  return provider.asInstructionProvider();
}
