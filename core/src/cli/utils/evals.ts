/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, Part} from '@google/genai';

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
 * Container for intermediate tool calls and agent responses generated during an invocation.
 */
export interface IntermediateData {
  tool_uses: FunctionCall[];
  intermediate_responses: IntermediateAgentResponseItem[];
}

/**
 * Represents a single invocation turn between a user and an agent.
 */
export interface Invocation {
  invocation_id?: string;
  user_content: Content;
  final_response?: Content;
  intermediate_data?: IntermediateData;
  creation_timestamp?: number;
}

/**
 * Initial session state and identity used when initializing a session during evaluation.
 */
export interface SessionInput {
  app_name: string;
  user_id: string;
  state?: Record<string, unknown>;
}

/**
 * A single evaluation case comprising a multi-turn conversation and optional session input.
 */
export interface EvalCase {
  eval_id: string;
  conversation: Invocation[];
  session_input?: SessionInput;
  creation_timestamp?: number;
}

/**
 * A collection of evaluation cases grouped into an evaluation set.
 */
export interface EvalSet {
  eval_set_id: string;
  name?: string;
  description?: string;
  eval_cases: EvalCase[];
  creation_timestamp?: number;
}

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
 * @deprecated Use {@link convertSessionToEvalInvocations} instead.
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

/**
 * Converts a session into a list of `Invocation` records suitable for saving
 * into an `EvalCase` or running through `runEvals`.
 *
 * @param session The session whose events should be converted.
 * @returns An array of `Invocation` records, one per user turn.
 */
export function convertSessionToEvalInvocations(
  session?: Session,
): Invocation[] {
  const invocations: Invocation[] = [];
  const events = session && session.events ? session.events : [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    if (event.author === 'user') {
      const userContent = event.content;
      const invocationId = event.invocationId;
      const creationTimestamp = event.timestamp;
      if (
        !userContent ||
        !userContent.parts ||
        userContent.parts.length === 0
      ) {
        i += 1;
        continue;
      }

      const toolUses: FunctionCall[] = [];
      const intermediateResponses: IntermediateAgentResponseItem[] = [];

      let j = i + 1;
      while (j < events.length) {
        const subsequentEvent = events[j];
        if (subsequentEvent.author === 'user') {
          break;
        }

        const eventAuthor = subsequentEvent.author || 'agent';
        if (subsequentEvent.content && subsequentEvent.content.parts) {
          const intermediateResponseParts: Part[] = [];
          for (const part of subsequentEvent.content.parts) {
            if (part.functionCall) {
              toolUses.push(part.functionCall);
            } else if (part.text) {
              intermediateResponseParts.push(part);
            }
          }

          if (intermediateResponseParts.length > 0) {
            intermediateResponses.push([
              eventAuthor,
              intermediateResponseParts,
            ]);
          }
        }

        j += 1;
      }

      invocations.push({
        invocation_id: invocationId,
        user_content: userContent,
        intermediate_data: {
          tool_uses: toolUses,
          intermediate_responses: intermediateResponses.slice(0, -1),
        },
        final_response:
          intermediateResponses.length > 0
            ? {
                parts:
                  intermediateResponses[intermediateResponses.length - 1][1],
              }
            : undefined,
        creation_timestamp: creationTimestamp,
      });
      i = j;
    } else {
      i += 1;
    }
  }

  return invocations;
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
