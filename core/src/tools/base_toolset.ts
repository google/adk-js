/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {getLogger} from '../utils/logger.js';

import {BaseTool} from './base_tool.js';
import {ToolContext} from './tool_context.js';

/**
 * Function to decide whether a tool should be exposed to LLM. Toolset
 * implementer could consider whether to accept such instance in the toolset's
 * constructor and apply the predicate in getTools method.
 */
export type ToolPredicate =
    (tool: BaseTool, readonlyContext: ReadonlyContext) => boolean;

/**
 * Base class for toolset.
 *
 * A toolset is a collection of tools that can be used by an agent.
 */
export abstract class BaseToolset {
  protected readonly logger = getLogger();

  constructor(readonly toolFilter: ToolPredicate|string[]) {}

  /**
   * Returns the tools that should be exposed to LLM.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools.
   */
  abstract getTools(context?: ReadonlyContext): Promise<BaseTool[]>;

  /**
   * Closes the toolset.
   *
   * NOTE: This method is invoked, for example, at the end of an agent server's
   * lifecycle or when the toolset is no longer needed. Implementations
   * should ensure that any open connections, files, or other managed
   * resources are properly released to prevent leaks.
   *
   * @return A Promise that resolves when the toolset is closed.
   */
  abstract close(): Promise<void>;

  /**
   * Returns whether the tool should be exposed to LLM.
   *
   * @param tool The tool to check.
   * @param context Context used to filter tools available to the agent.
   * @return Whether the tool should be exposed to LLM.
   */
  protected isToolSelected(tool: BaseTool, context: ReadonlyContext): boolean {
    if (!this.toolFilter) {
      return true;
    }

    if (typeof this.toolFilter === 'function') {
      return this.toolFilter(tool, context);
    }

    if (Array.isArray(this.toolFilter)) {
      return (this.toolFilter as string[]).includes(tool.name);
    }

    return false;
  }

  /**
   * Processes the outgoing LLM request for this toolset. This method will be
   * called before each tool processes the llm request.
   *
   * Use cases:
   * - Instead of let each tool process the llm request, we can let the toolset
   *   process the llm request. e.g. ComputerUseToolset can add computer use
   *   tool to the llm request.
   *
   * @param toolContext The context of the tool.
   * @param llmRequest The outgoing LLM request, mutable this method.
   */
  async processLlmRequest(
      toolContext: ToolContext,
      llmRequest: LlmRequest,
      ): Promise<void> {}
}
