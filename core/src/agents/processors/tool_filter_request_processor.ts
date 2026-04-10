/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {LlmRequest} from '../../models/llm_request.js';
import {BaseTool} from '../../tools/base_tool.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

export class ToolFilterRequestProcessor extends BaseLlmRequestProcessor {
  /** Filters the set of tools on the request based on plugins. */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    // Get all tools resolved to BaseTool
    const toolsList = await agent.canonicalTools(
      new ReadonlyContext(invocationContext),
    );

    if (toolsList.length === 0) {
      return;
    }

    const toolsDict: Record<string, BaseTool> = {};
    for (const tool of toolsList) {
      toolsDict[tool.name] = tool;
    }

    const callbackContext = new Context({invocationContext});

    // Call plugins to filter tools
    const filteredTools =
      await invocationContext.pluginManager.runBeforeToolSelection({
        callbackContext,
        tools: toolsDict,
      });

    // If plugins returned a filtered set, update allowedTools
    if (filteredTools !== undefined) {
      llmRequest.allowedTools = Object.keys(filteredTools);
    }
  }
}

export const TOOL_FILTER_REQUEST_PROCESSOR = new ToolFilterRequestProcessor();
