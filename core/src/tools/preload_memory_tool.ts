/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {appendInstructions} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * A tool that preloads the memory for the current user.
 *
 * This tool will be automatically executed for each llm_request, and it won't be
 * called by the model.
 *
 * NOTE: Currently this tool only uses text part from the memory.
 */
export class PreloadMemoryTool extends BaseTool {
  constructor() {
    super({
      // Name and description are not used because this tool only
      // changes llm_request.
      name: 'preload_memory',
      description: 'preload_memory',
    });
  }

  override async runAsync({
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    args,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    // Should not be called by model because it's not declared in LLM tools list.
    throw new Error('PreloadMemoryTool should not be called by model');
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);

    const userContent = request.toolContext.userContent;
    if (!userContent || !userContent.parts || !userContent.parts[0]?.text) {
      return;
    }

    const userQuery = userContent.parts[0].text;
    let response;
    try {
      if (!request.toolContext.invocationContext.memoryService) {
        return; // Handle gracefully if no memory service
      }
      response = await request.toolContext.searchMemory(userQuery);
    } catch (_) {
      logger.warn(`Failed to preload memory for query: ${userQuery}`);
      return;
    }

    if (!response.memories || response.memories.length === 0) {
      return;
    }

    const memoryTextLines: string[] = [];
    for (const memory of response.memories) {
      const timeStr = memory.timestamp ? `Time: ${memory.timestamp}` : '';
      if (timeStr) memoryTextLines.push(timeStr);

      const memoryText =
        memory.content.parts?.map((p) => p.text ?? '').join(' ') ?? '';
      if (memoryText) {
        memoryTextLines.push(
          memory.author ? `${memory.author}: ${memoryText}` : memoryText,
        );
      }
    }

    if (memoryTextLines.length === 0) {
      return;
    }

    const fullMemoryText = memoryTextLines.join('\n');
    const si = `The following content is from your previous conversations with the user.
They may be useful for answering the user's current query.
<PAST_CONVERSATIONS>
${fullMemoryText}
</PAST_CONVERSATIONS>
`;

    appendInstructions(request.llmRequest, [si]);
  }
}

/**
 * A global instance of {@link PreloadMemoryTool}.
 */
export const PRELOAD_MEMORY = new PreloadMemoryTool();
