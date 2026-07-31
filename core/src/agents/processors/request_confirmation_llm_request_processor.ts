/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {ToolConfirmation} from '../../tools/tool_confirmation.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  handleFunctionCallList,
} from '../functions.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Resumes tool calls that were paused for user confirmation. Scans the session
 * event history for pending confirmation responses and re-invokes the
 * corresponding tools before the next LLM turn.
 */
export class RequestConfirmationLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Resumes tool calls that were paused for user confirmation, re-invoking
   * them with the confirmed or denied decision before the next LLM turn.
   *
   * @param invocationContext - The current invocation context, including the
   *   session event history used to locate pending confirmation responses.
   * @yields Function response events for tools that have been confirmed and
   *   are ready to resume.
   */
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    const events = invocationContext.session.events;
    if (!events || events.length === 0) {
      return;
    }

    const requestConfirmationFunctionResponses: {
      [key: string]: ToolConfirmation;
    } = {};

    let confirmationEventIndex = -1;
    // Step 1: Find the FIRST confirmation event authored by user.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author !== 'user') {
        continue;
      }
      const responses = getFunctionResponses(event);
      if (!responses) {
        continue;
      }

      let foundConfirmation = false;
      for (const functionResponse of responses) {
        if (functionResponse.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
          continue;
        }
        foundConfirmation = true;

        let toolConfirmation = null;

        if (
          functionResponse.response &&
          Object.keys(functionResponse.response).length === 1 &&
          'response' in functionResponse.response
        ) {
          toolConfirmation = JSON.parse(
            functionResponse.response['response'] as string,
          ) as ToolConfirmation;
        } else if (functionResponse.response) {
          toolConfirmation = new ToolConfirmation({
            hint: functionResponse.response['hint'] as string,
            payload: functionResponse.response['payload'],
            confirmed: functionResponse.response['confirmed'] as boolean,
          });
        }

        if (functionResponse.id && toolConfirmation) {
          requestConfirmationFunctionResponses[functionResponse.id] =
            toolConfirmation;
        }
      }
      if (foundConfirmation) {
        confirmationEventIndex = i;
        break;
      }
    }

    // Plain-text fallback: an interactive user (e.g. `adk run`) can approve or
    // deny a pending confirmation by simply typing a reply (yes/no) instead of
    // sending a structured confirmation response.
    if (Object.keys(requestConfirmationFunctionResponses).length === 0) {
      const fallback = mapPlainTextConfirmation(events);
      Object.assign(requestConfirmationFunctionResponses, fallback.responses);
      if (fallback.turnIndex >= 0) {
        confirmationEventIndex = fallback.turnIndex;
      }
    }

    if (Object.keys(requestConfirmationFunctionResponses).length === 0) {
      return;
    }

    // Step 2: Find the system generated FunctionCall event requesting the tool
    // confirmation
    for (let i = confirmationEventIndex - 1; i >= 0; i--) {
      const event = events[i];
      const functionCalls = getFunctionCalls(event);
      if (!functionCalls) {
        continue;
      }

      const toolsToResumeWithConfirmation: {[key: string]: ToolConfirmation} =
        {};
      const toolsToResumeWithArgs: {[key: string]: FunctionCall} = {};

      for (const functionCall of functionCalls) {
        if (
          !functionCall.id ||
          !(functionCall.id in requestConfirmationFunctionResponses)
        ) {
          continue;
        }

        const args = functionCall.args;
        if (!args || !('originalFunctionCall' in args)) {
          continue;
        }
        const originalFunctionCall = args[
          'originalFunctionCall'
        ] as FunctionCall;

        if (originalFunctionCall.id) {
          toolsToResumeWithConfirmation[originalFunctionCall.id] =
            requestConfirmationFunctionResponses[functionCall.id];
          toolsToResumeWithArgs[originalFunctionCall.id] = originalFunctionCall;
        }
      }
      if (Object.keys(toolsToResumeWithConfirmation).length === 0) {
        continue;
      }

      // Step 3: Remove the tools that have already been confirmed AND resumed.
      for (let j = events.length - 1; j > confirmationEventIndex; j--) {
        const eventToCheck = events[j];
        const functionResponses = getFunctionResponses(eventToCheck);
        if (!functionResponses) {
          continue;
        }

        for (const fr of functionResponses) {
          if (fr.id && fr.id in toolsToResumeWithConfirmation) {
            delete toolsToResumeWithConfirmation[fr.id];
            delete toolsToResumeWithArgs[fr.id];
          }
        }
        if (Object.keys(toolsToResumeWithConfirmation).length === 0) {
          break;
        }
      }

      if (Object.keys(toolsToResumeWithConfirmation).length === 0) {
        continue;
      }

      const toolsList = await agent.canonicalTools(
        new ReadonlyContext(invocationContext),
      );
      const toolsDict = Object.fromEntries(
        toolsList.map((tool) => [tool.name, tool]),
      );

      const functionResponseEvent = await handleFunctionCallList({
        invocationContext: invocationContext,
        functionCalls: Object.values(toolsToResumeWithArgs),
        toolsDict: toolsDict,
        beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
        afterToolCallbacks: agent.canonicalAfterToolCallbacks,
        filters: new Set(Object.keys(toolsToResumeWithConfirmation)),
        toolConfirmationDict: toolsToResumeWithConfirmation,
      });

      if (functionResponseEvent) {
        yield functionResponseEvent;
      }
      return;
    }
  }
}

/** Words interpreted as an approval when a user confirms by plain text. */
const AFFIRMATIVE = new Set([
  'yes',
  'y',
  'true',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'confirmed',
]);

/**
 * Maps a plain-text user reply to confirmations for any still-pending
 * `adk_request_confirmation` calls, so a user can approve/deny by typing.
 * Returns the synthesized confirmations keyed by the confirmation call id, and
 * the index of the plain-text user turn (or -1 when not applicable).
 */
function mapPlainTextConfirmation(events: Event[]): {
  responses: Record<string, ToolConfirmation>;
  turnIndex: number;
} {
  const answered = new Set<string>();
  for (const event of events) {
    if (event.author !== 'user') {
      continue;
    }
    for (const fr of getFunctionResponses(event)) {
      if (fr.id) {
        answered.add(fr.id);
      }
    }
  }
  const pendingIds: string[] = [];
  for (const event of events) {
    for (const fc of getFunctionCalls(event)) {
      if (
        fc.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
        fc.id &&
        !answered.has(fc.id)
      ) {
        pendingIds.push(fc.id);
      }
    }
  }
  if (pendingIds.length === 0) {
    return {responses: {}, turnIndex: -1};
  }

  // Only the most recent user turn is considered, and only if it is plain text.
  let turnIndex = -1;
  let text = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== 'user') {
      continue;
    }
    const parts = event.content?.parts ?? [];
    const isPlainText =
      parts.length > 0 && parts.every((p) => typeof p.text === 'string');
    if (isPlainText) {
      turnIndex = i;
      text = parts.map((p) => p.text).join('');
    }
    break;
  }
  if (turnIndex < 0) {
    return {responses: {}, turnIndex: -1};
  }

  const confirmed = AFFIRMATIVE.has(text.trim().toLowerCase());
  const responses: Record<string, ToolConfirmation> = {};
  for (const id of pendingIds) {
    responses[id] = new ToolConfirmation({confirmed});
  }
  return {responses, turnIndex};
}

export const REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR =
  new RequestConfirmationLlmRequestProcessor();
