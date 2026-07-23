/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {BaseLlm} from '../models/base_llm.js';

import {AgentTool} from './agent_tool.js';
import {GOOGLE_SEARCH} from './google_search_tool.js';

/**
 * Creates a sub-agent that only uses the `google_search` tool.
 *
 * @param model The model id string (e.g. `'gemini-2.0-flash'`) or a
 *     {@link BaseLlm} instance to back the search sub-agent.
 * @returns An {@link LlmAgent} named `google_search_agent` whose only tool is
 *     the built-in `google_search` tool.
 */
export function createGoogleSearchAgent(model: string | BaseLlm): LlmAgent {
  return new LlmAgent({
    name: 'google_search_agent',
    model,
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
 * A tool that wraps a sub-agent whose only tool is the built-in
 * `google_search` tool.
 *
 * ## When you need this
 *
 * Built-in search tools are subject to a multi-tool limit: on Gemini 1.x
 * models a built-in search tool may not be sent in the same request as any
 * other tool. {@link VertexAiSearchTool} lets you opt out of that check with
 * its `bypassMultiToolsLimit` option, but {@link GoogleSearchTool} has no
 * equivalent escape hatch — adding `GOOGLE_SEARCH` to a Gemini 1.x agent that
 * already has other tools always throws `Google search tool can not be used
 * with other tools in Gemini 1.x.`
 *
 * `GoogleSearchAgentTool` sidesteps the limit rather than bypassing it. The
 * search happens in an isolated sub-agent invocation whose request carries
 * only `google_search`, and the parent agent calls that sub-agent as an
 * ordinary function tool alongside its other tools — so neither request ever
 * violates the limit.
 *
 * Reach for this when you need Google Search *and* other tools on a Gemini 1.x
 * agent, or when you want search confined to a separate invocation (for
 * example to keep its instructions and context out of the parent). On Gemini 2
 * and later, ADK applies no multi-tool check, so plain `GOOGLE_SEARCH` on the
 * agent is simpler and this wrapper is unnecessary.
 *
 * Grounding metadata produced by the sub-agent's search is propagated back to
 * the parent invocation under the `temp:_adk_grounding_metadata` state key.
 */
export class GoogleSearchAgentTool extends AgentTool {
  constructor(agent: LlmAgent) {
    super({agent, propagateGroundingMetadata: true});
  }
}
