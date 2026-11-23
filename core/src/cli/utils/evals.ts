/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, FunctionResponse, Part} from '@google/genai';

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
 * Intermediate tool uses and sub-agent responses recorded during an evaluation
 * invocation.
 */
export interface EvalIntermediateData {
  toolUses: FunctionCall[];
  /**
   * Expected responses for entries in {@link toolUses}, matched by `id`. When
   * an eval runs, a matching response replaces the real tool call, so the
   * response acts as a mock tool output.
   */
  toolResponses?: FunctionResponse[];
  intermediateResponses: IntermediateAgentResponseItem[];
}

/**
 * Represents a single user-to-agent invocation in an evaluation case.
 */
export interface EvalInvocation {
  invocationId?: string;
  userContent: Content;
  finalResponse?: Content;
  intermediateData?: EvalIntermediateData;
  creationTimestamp?: number;
}

/**
 * Initial session metadata for an {@link EvalCase}.
 */
export interface EvalSessionInput {
  appName: string;
  userId: string;
  state: Record<string, unknown>;
}

/**
 * A structured evaluation case containing a multi-turn conversation and
 * optional initial session state.
 */
export interface EvalCase {
  evalId: string;
  conversation: EvalInvocation[];
  sessionInput?: EvalSessionInput;
  creationTimestamp?: number;
}

/**
 * A named collection of {@link EvalCase} items stored in an `.evalset.json`
 * file.
 */
export interface EvalSet {
  evalSetId: string;
  name?: string;
  description?: string;
  evalCases: EvalCase[];
  creationTimestamp?: number;
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
      if (
        !event.content ||
        !event.content.parts ||
        event.content.parts.length === 0
      ) {
        i += 1;
        continue;
      }

      let userQuery = '';
      for (const part of event.content.parts) {
        if (part.text) {
          userQuery = part.text;
          break;
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
          const textParts: Part[] = [];
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
            } else if (part.text) {
              textParts.push(part);
            }
          }

          if (!hasToolAction && textParts.length > 0) {
            expectedIntermediateAgentResponses.push([
              subsequentEvent.author ?? '',
              subsequentEvent.content.parts,
            ]);
          } else if (hasToolAction && textParts.length > 0) {
            expectedIntermediateAgentResponses.push([
              subsequentEvent.author ?? '',
              textParts,
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
 * Converts a session into a list of {@link EvalInvocation} items, grouping each
 * user turn with its subsequent agent tool calls, intermediate responses, and
 * final response.
 *
 * @param session The session whose events should be converted.
 * @returns An array of {@link EvalInvocation} records, one per user turn.
 */
export function convertSessionToEvalInvocations(
  session?: Session,
): EvalInvocation[] {
  const invocations: EvalInvocation[] = [];
  const events = session && session.events ? session.events : [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.author !== 'user') {
      continue;
    }
    if (
      !event.content ||
      !event.content.parts ||
      event.content.parts.length === 0
    ) {
      continue;
    }

    const userContent = event.content;
    const invocationId = event.invocationId || undefined;
    // `Event.timestamp` is in milliseconds; eval sets store seconds.
    const creationTimestamp =
      event.timestamp !== undefined ? event.timestamp / 1000 : undefined;
    const toolUses: FunctionCall[] = [];
    const intermediateResponses: IntermediateAgentResponseItem[] = [];

    for (let j = i + 1; j < events.length; j++) {
      const subsequentEvent = events[j];
      const eventAuthor = subsequentEvent.author || 'agent';
      if (eventAuthor === 'user') {
        break;
      }
      if (
        !subsequentEvent.content ||
        !subsequentEvent.content.parts ||
        subsequentEvent.content.parts.length === 0
      ) {
        continue;
      }

      const intermediateResponseParts: Part[] = [];
      for (const subsequentPart of subsequentEvent.content.parts) {
        if (subsequentPart.functionCall) {
          toolUses.push(subsequentPart.functionCall);
        } else if (subsequentPart.text) {
          intermediateResponseParts.push(subsequentPart);
        }
      }

      if (intermediateResponseParts.length > 0) {
        intermediateResponses.push([eventAuthor, intermediateResponseParts]);
      }
    }

    const finalResponse: Content | undefined =
      intermediateResponses.length > 0
        ? {
            parts: intermediateResponses[intermediateResponses.length - 1][1],
            role: 'model',
          }
        : undefined;

    invocations.push({
      ...(invocationId !== undefined ? {invocationId} : {}),
      userContent,
      ...(finalResponse !== undefined ? {finalResponse} : {}),
      intermediateData: {
        toolUses,
        intermediateResponses:
          intermediateResponses.length > 0
            ? intermediateResponses.slice(0, -1)
            : [],
      },
      ...(creationTimestamp !== undefined ? {creationTimestamp} : {}),
    });
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
