/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {BaseAgent} from '../../agents/base_agent.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {Session} from '../../sessions/session.js';

/**
 * Represents a single expected tool invocation in an evaluation item.
 */
export interface ToolUseItem {
  tool_name: string;
  tool_input: Record<string, unknown>;
  mock_tool_output?: unknown;
}

/**
 * Represents an intermediate agent response tuple of `[author, parts]`.
 */
export type IntermediateAgentResponseItem = [string, Part[]];

/**
 * Represents a single turn in an evaluation dataset converted from a session.
 */
export interface EvaluationItem {
  query: string;
  expected_tool_use: ToolUseItem[];
  expected_intermediate_agent_responses: IntermediateAgentResponseItem[];
  reference: string;
}

/**
 * Converts a session into a list of evaluation items suitable for saving into
 * an evalset or running through `runEvals`.
 *
 * @param session The session whose events should be converted.
 * @returns An array of `EvaluationItem` records, one per user turn.
 */
export function convertSessionToEvalFormat(
  session?: Session,
): EvaluationItem[] {
  const events = session && session.events ? session.events : [];
  const evalCases: EvaluationItem[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    if (event.author === 'user') {
      let userQuery = '';
      if (event.content && event.content.parts) {
        for (const part of event.content.parts) {
          if (part.text) {
            userQuery = part.text;
            break;
          }
        }
      }

      const expectedToolUse: ToolUseItem[] = [];
      const expectedIntermediateAgentResponses: IntermediateAgentResponseItem[] =
        [];
      let finalResponse = '';

      let j = i + 1;
      while (j < events.length) {
        const subsequentEvent = events[j];
        if (subsequentEvent.author === 'user') {
          break;
        }

        if (subsequentEvent.content && subsequentEvent.content.parts) {
          let hasToolAction = false;
          for (const part of subsequentEvent.content.parts) {
            if (part.functionCall) {
              expectedToolUse.push({
                tool_name: part.functionCall.name ?? '',
                tool_input: (part.functionCall.args ?? {}) as Record<
                  string,
                  unknown
                >,
              });
              hasToolAction = true;
            } else if (part.functionResponse) {
              hasToolAction = true;
            }
          }

          if (!hasToolAction) {
            expectedIntermediateAgentResponses.push([
              subsequentEvent.author ?? '',
              subsequentEvent.content.parts,
            ]);
          }
        }

        j += 1;
      }

      if (expectedIntermediateAgentResponses.length > 0) {
        const lastResponse = expectedIntermediateAgentResponses.pop();
        if (lastResponse) {
          const [, lastParts] = lastResponse;
          finalResponse = lastParts
            .filter((part) => Boolean(part.text))
            .map((part) => part.text ?? '')
            .join('');
        }
      }

      evalCases.push({
        query: userQuery,
        expected_tool_use: expectedToolUse,
        expected_intermediate_agent_responses:
          expectedIntermediateAgentResponses,
        reference: finalResponse,
      });
      i = j;
    } else {
      i += 1;
    }
  }

  return evalCases;
}

function populateEmptyState(
  agent: BaseAgent,
  allState: Record<string, unknown>,
): void {
  for (const subAgent of agent.subAgents) {
    populateEmptyState(subAgent, allState);
  }

  if (
    isLlmAgent(agent) &&
    agent.instruction &&
    typeof agent.instruction === 'string'
  ) {
    const matches = agent.instruction.matchAll(/\{([\w]+)\}/g);
    for (const match of matches) {
      allState[match[1]] = '';
    }
  }
}

/**
 * Creates a state object initialized with empty strings `''` for all `{var}`
 * placeholders referenced in the instruction strings of `agent` and its
 * sub-agents, overridden by any keys provided in `initializedStates`.
 *
 * @param agent The root agent to inspect.
 * @param initializedStates Optional pre-initialized state values that take precedence.
 * @returns The combined state record.
 */
export function createEmptyState(
  agent: BaseAgent,
  initializedStates?: Record<string, unknown>,
): Record<string, unknown> {
  const subAgentsState: Record<string, unknown> = {};
  populateEmptyState(agent, subAgentsState);
  if (initializedStates) {
    for (const [k, v] of Object.entries(initializedStates)) {
      subAgentsState[k] = v;
    }
  }
  return subAgentsState;
}
