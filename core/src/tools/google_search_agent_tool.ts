/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {BaseLlm} from '../models/base_llm.js';
import {experimental} from '../utils/experimental.js';
import {AgentTool} from './agent_tool.js';
import {GOOGLE_SEARCH} from './google_search_tool.js';

/**
 * Create a sub-agent that only uses google_search tool.
 *
 * @param model The model to use for the sub-agent.
 * @returns The LlmAgent instance.
 */
export function createGoogleSearchAgent(model: string | BaseLlm): LlmAgent {
  return new LlmAgent({
    name: 'google_search_agent',
    model: model,
    description:
      'An agent for performing Google search using the `google_search` tool',
    instruction: `
        You are a specialized Google search agent.

        When given a search query, use the \`google_search\` tool to find the related information.
    `,
    tools: [GOOGLE_SEARCH],
  });
}

/**
 * A tool that wraps a sub-agent that only uses google_search tool.
 *
 * This is a workaround to support using google_search tool with other tools.
 */
@experimental
export class GoogleSearchAgentTool extends AgentTool {
  constructor(agent: LlmAgent) {
    super({
      agent,
      propagateGroundingMetadata: true,
    });
  }
}
