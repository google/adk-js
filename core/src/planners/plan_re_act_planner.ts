/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {BasePlanner} from './base_planner.js';

/** Tag marking the natural-language planning section of a response. */
export const PLANNING_TAG = '/*PLANNING*/';
/** Tag marking a revised plan after a failed execution attempt. */
export const REPLANNING_TAG = '/*REPLANNING*/';
/** Tag marking a reasoning summary between tool-code snippets. */
export const REASONING_TAG = '/*REASONING*/';
/** Tag marking a tool-code snippet (action) section of a response. */
export const ACTION_TAG = '/*ACTION*/';
/** Tag marking the final, user-visible answer section of a response. */
export const FINAL_ANSWER_TAG = '/*FINAL_ANSWER*/';

/**
 * Plan-Re-Act planner that constrains the LLM response to generate a plan
 * before any action/observation.
 *
 * Note: this planner does not require the model to support built-in thinking
 * features or setting the thinking config.
 */
export class PlanReActPlanner extends BasePlanner {
  override buildPlanningInstruction(
    _readonlyContext: ReadonlyContext,
    _llmRequest: LlmRequest,
  ): string {
    return buildNlPlannerInstruction();
  }

  override processPlanningResponse(
    _callbackContext: Context,
    responseParts: Part[],
  ): Part[] | undefined {
    if (!responseParts || responseParts.length === 0) {
      return undefined;
    }

    const preservedParts: Part[] = [];
    let firstFcPartIndex = -1;
    for (let i = 0; i < responseParts.length; i++) {
      // Stop at the first (group of) function calls.
      if (responseParts[i].functionCall) {
        // Ignore and filter out function calls with empty names.
        if (!responseParts[i].functionCall!.name) {
          continue;
        }
        preservedParts.push(responseParts[i]);
        firstFcPartIndex = i;
        break;
      }

      // Split the response into reasoning and final answer parts.
      handleNonFunctionCallParts(responseParts[i], preservedParts);
    }

    if (firstFcPartIndex >= 0) {
      let j = firstFcPartIndex + 1;
      while (j < responseParts.length) {
        if (responseParts[j].functionCall) {
          preservedParts.push(responseParts[j]);
          j++;
        } else {
          break;
        }
      }
    }

    return preservedParts;
  }
}

/**
 * Splits the text by the last occurrence of the separator.
 *
 * @param text The text to split.
 * @param separator The separator to split on.
 * @returns A tuple containing the text before (and including) the last
 *     separator and the text after the last separator.
 */
export function splitByLastPattern(
  text: string,
  separator: string,
): [string, string] {
  const index = text.lastIndexOf(separator);
  if (index === -1) {
    return [text, ''];
  }
  return [
    text.slice(0, index + separator.length),
    text.slice(index + separator.length),
  ];
}

/**
 * Handles non-function-call parts of the response.
 *
 * @param responsePart The response part to handle.
 * @param preservedParts The mutable list of parts to store the processed parts
 *     in.
 */
export function handleNonFunctionCallParts(
  responsePart: Part,
  preservedParts: Part[],
): void {
  if (responsePart.text && responsePart.text.includes(FINAL_ANSWER_TAG)) {
    const [reasoningText, finalAnswerText] = splitByLastPattern(
      responsePart.text,
      FINAL_ANSWER_TAG,
    );
    if (reasoningText) {
      const reasoningPart: Part = {text: reasoningText};
      markAsThought(reasoningPart);
      preservedParts.push(reasoningPart);
    }
    if (finalAnswerText) {
      preservedParts.push({text: finalAnswerText});
    }
  } else {
    const responseText = responsePart.text ?? '';
    // If the part is a text part with a planning/reasoning/action tag,
    // label it as reasoning.
    if (
      responseText &&
      [PLANNING_TAG, REASONING_TAG, ACTION_TAG, REPLANNING_TAG].some((tag) =>
        responseText.startsWith(tag),
      )
    ) {
      markAsThought(responsePart);
    }
    preservedParts.push(responsePart);
  }
}

/**
 * Marks the response part as thought.
 *
 * @param responsePart The mutable response part to mark as thought.
 */
export function markAsThought(responsePart: Part): void {
  if (responsePart.text) {
    responsePart.thought = true;
  }
}

/**
 * Builds the NL planner instruction for the Plan-Re-Act planner.
 *
 * @returns NL planner system instruction.
 */
export function buildNlPlannerInstruction(): string {
  const highLevelPreamble = `
When answering the question, try to leverage the available tools to gather the information instead of your memorized knowledge.

Follow this process when answering the question: (1) first come up with a plan in natural language text format; (2) Then use tools to execute the plan and provide reasoning between tool code snippets to make a summary of current state and next step. Tool code snippets and reasoning should be interleaved with each other. (3) In the end, return one final answer.

Follow this format when answering the question: (1) The planning part should be under ${PLANNING_TAG}. (2) The tool code snippets should be under ${ACTION_TAG}, and the reasoning parts should be under ${REASONING_TAG}. (3) The final answer part should be under ${FINAL_ANSWER_TAG}.
`;

  const planningPreamble = `
Below are the requirements for the planning:
The plan is made to answer the user query if following the plan. The plan is coherent and covers all aspects of information from user query, and only involves the tools that are accessible by the agent. The plan contains the decomposed steps as a numbered list where each step should use one or multiple available tools. By reading the plan, you can intuitively know which tools to trigger or what actions to take.
If the initial plan cannot be successfully executed, you should learn from previous execution results and revise your plan. The revised plan should be under ${REPLANNING_TAG}. Then use tools to follow the new plan.
`;

  const reasoningPreamble = `
Below are the requirements for the reasoning:
The reasoning makes a summary of the current trajectory based on the user query and tool outputs. Based on the tool outputs and plan, the reasoning also comes up with instructions to the next steps, making the trajectory closer to the final answer.
`;

  const finalAnswerPreamble = `
Below are the requirements for the final answer:
The final answer should be precise and follow query formatting requirements. Some queries may not be answerable with the available tools and information. In those cases, inform the user why you cannot process their query and ask for more information.
`;

  // Only contains the requirements for custom tool/libraries.
  const toolCodeWithoutPythonLibrariesPreamble = `
Below are the requirements for the tool code:

**Custom Tools:** The available tools are described in the context and can be directly used.
- Code must be valid self-contained Python snippets with no imports and no references to tools or Python libraries that are not in the context.
- You cannot use any parameters or fields that are not explicitly defined in the APIs in the context.
- The code snippets should be readable, efficient, and directly relevant to the user query and reasoning steps.
- When using the tools, you should use the library name together with the function name, e.g., vertex_search.search().
- If Python libraries are not provided in the context, NEVER write your own code other than the function calls using the provided tools.
`;

  const userInputPreamble = `
VERY IMPORTANT instruction that you MUST follow in addition to the above instructions:

You should ask for clarification if you need more information to answer the question.
You should prefer using the information available in the context instead of repeated tool use.
`;

  return [
    highLevelPreamble,
    planningPreamble,
    reasoningPreamble,
    finalAnswerPreamble,
    toolCodeWithoutPythonLibrariesPreamble,
    userInputPreamble,
  ].join('\n\n');
}
