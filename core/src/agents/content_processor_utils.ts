/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Content} from '@google/genai';

import {Event} from '../events/event.js';
import {deepClone} from '../utils/deep_clone.js';

import {removeClientFunctionCallId, REQUEST_EUC_FUNCTION_CALL_NAME} from './functions.js';

/**
 * Get the contents for the LLM request.
 *
 * @param events: A list of all session events.
 * @param agentName: The name of the agent.
 * @param currentBranch: The current branch of the agent.
 *
 * @returns A list of processed contents.
 */
export function getContents(
    events: Event[], agentName: string, currentBranch?: string): Content[] {
  const filteredEvents: Event[] = [];

  for (const event of events) {
    // Skip events without content, or generated neither by user nor by model.
    // E.g. events purely for mutating session states.
    if (!event.content?.role || event.content.parts?.[0]?.text === '') {
      continue;
    }

    // Skip events not in the current branch.
    // TODO - b/425992518: inefficient, a tire search is better.
    if (currentBranch && event.branch &&
        !currentBranch.startsWith(event.branch)) {
      continue;
    }

    if (isAuthEvent(event)) {
      continue;
    }

    filteredEvents.push(
        isEventFromAnotherAgent(agentName, event) ? convertForeignEvent(event) :
                                                    event);
  }

  let resultEvents = rearrangeEventsForLatestFunctionResponse(filteredEvents);
  resultEvents =
      rearrangeEventsForAsyncFunctionResponsesInHistory(resultEvents);
  const contents = [];
  for (const event of resultEvents) {
    const content = deepClone(event.content) as Content;
    removeClientFunctionCallId(content);
    contents.push(content);
  }
  return contents;
}

/**
 * Get contents for the current turn only (no conversation history).
 *
 * When include_contents='none', we want to include:
 * - The current user input
 * - Tool calls and responses from the current turn
 * But exclude conversation history from previous turns.
 *
 * In multi-agent scenarios, the "current turn" for an agent starts from an
 * actual user or from another agent.
 *
 * @param events: A list of all session events.
 * @param agentName: The name of the agent.
 * @param currentBranch: The current branch of the agent.
 *
 * @returns A list of contents for the current turn only, preserving context
 *     needed for proper tool execution while excluding conversation history.
 */
export function getCurrentTurnContents(
    events: Event[],
    agentName: string,
    currentBranch?: string,
    ): Content[] {
  // Find the latest event that starts the current turn and process from there.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author === 'user' || isEventFromAnotherAgent(agentName, event)) {
      return getContents(events.slice(i), agentName, currentBranch);
    }
  }

  return [];
}

/**
 * Whether the event is an auth event.
 *
 * An auth event is an event that contains a function call or response
 * related to requesting end-user credentials (EUC). These events are
 * skipped when constructing the content for the LLM request.
 */
function isAuthEvent(event: Event): boolean {
  if (!event.content?.parts) {
    return false;
  }
  for (const part of event.content.parts) {
    if (part.functionCall?.name === REQUEST_EUC_FUNCTION_CALL_NAME ||
        part.functionResponse?.name === REQUEST_EUC_FUNCTION_CALL_NAME) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the event is from another agent.
 */
function isEventFromAnotherAgent(agentName: string, event: Event): boolean {
  return !!agentName && event.author !== agentName && event.author !== 'user';
}

/**
 * Formats an event authored by another agent to a user-content event.
 *
 * This is to provide another agent's output as context to the current agent,
 * so that current agent can continue to respond, such as summarizing previous
 * agent's reply, etc.
 *
 * @param event The event to convert.
 *
 * @returns The converted event.
 */
function convertForeignEvent(event: Event): Event {
  if (!event.content?.parts) {
    return event;
  }

  const content: Content = {
    role: 'user',
    parts: [{
      text: 'For context:',
    }],
  };

  for (const part of event.content.parts) {
    if (part.text) {
      content.parts?.push({
        text: `[${event.author}] said: ${part.text}`,
      });
    } else if (part.functionCall) {
      content.parts?.push({
        text: `[${event.author}] called tool \`${
            part.functionCall.name}\` with parameters: ${
            part.functionCall.args}`,
      });
    } else if (part.functionResponse) {
      content.parts?.push({
        text: `[${event.author}] tool \`${
            part.functionResponse.name}\` returned result: ${
            part.functionResponse.response}`,
      });
    } else {
      content.parts?.push(part);
    }
  }

  return new Event({
    invocationId: event.invocationId,
    author: 'user',
    content,
    branch: event.branch,
    timestamp: event.timestamp,
  });
}

/**
 * Merges a list of function_response events into one event.
 *
 * The key goal is to ensure:
 *  1. function_call and function_response are always of the same number.
 *  2. The function_call and function_response are consecutively in the content.
 *
 * @param events: A list of function_response events.
 *
 * NOTE:
 * function_response_events must fulfill these requirements:
 * 1. The list is in increasing order of timestamp;
 * 2. the first event is the initial function_response event;
 * 3. all later events should contain at least one function_response part that
 * related to the function_call event. Caveat: This implementation doesn't
 * support when a parallel function_call event contains async function_call of
 * the same name.
 *
 * @returns
 *    A merged event, that is
 *      1. All later function_response will replace function_response part in
 *          the initial function_response event.
 *      2. All non-function_response parts will be appended to the part list of
 *          the initial function_response event.
 */
function mergeFunctionResponseEvents(events: Event[]): Event {
  if (events.length === 0) {
    throw new Error('Cannot merge an empty list of events.');
  }

  const mergedEvent = new Event(events[0]);
  const partsInMergedEvent = mergedEvent.content?.parts || [];

  if (partsInMergedEvent.length === 0) {
    throw new Error('There should be at least one function_response part.');
  }

  const partIndicesInMergedEvent: Record<string, number> = {};
  for (let i = 0; i < partsInMergedEvent.length; i++) {
    const part = partsInMergedEvent[i];
    if (part.functionResponse && part.functionResponse.id) {
      partIndicesInMergedEvent[part.functionResponse.id] = i;
    }
  }

  for (const event of events.slice(1)) {
    if (!event.content || !event.content.parts) {
      throw new Error('There should be at least one function_response part.');
    }
    for (const part of event.content.parts) {
      if (part.functionResponse && part.functionResponse.id) {
        const functionCallId = part.functionResponse.id;
        if (functionCallId in partIndicesInMergedEvent) {
          partsInMergedEvent[partIndicesInMergedEvent[functionCallId]] = part;
        } else {
          partsInMergedEvent.push(part);
          partIndicesInMergedEvent[functionCallId] =
              partsInMergedEvent.length - 1;
        }
      } else {
        partsInMergedEvent.push(part);
      }
    }
  }

  return mergedEvent;
}

/**
 * Rearrange the async functionResponse events in the history.
 */
function rearrangeEventsForLatestFunctionResponse(
    events: Event[],
    ): Event[] {
  if (events.length === 0) {
    return events;
  }

  const latestEvent = events[events.length - 1];
  const functionResponses = latestEvent.getFunctionResponses();

  // No need to process, since the latest event is not functionResponse.
  if (!functionResponses?.length) {
    return events;
  }

  let functionResponsesIds = new Set<string>(
      functionResponses
          .filter((response): response is {id: string} => !!response.id)
          .map((response) => response.id),
  );

  // No need to rearrange if the second latest event already contains the
  // corresponding function calls for the latest function responses.
  const secondLatestEvent = events.at(-2);
  if (secondLatestEvent) {
    const functionCallsFromSecondLatest = secondLatestEvent.getFunctionCalls();
    if (functionCallsFromSecondLatest) {
      for (const functionCall of functionCallsFromSecondLatest) {
        if (functionCall.id && functionResponsesIds.has(functionCall.id)) {
          return events;
        }
      }
    }
  }

  // Look for corresponding function call event reversely.
  let functionCallEventIdx = -1;
  for (let idx = events.length - 2; idx >= 0; idx--) {
    const event = events[idx];
    const functionCalls = event.getFunctionCalls();
    if (!functionCalls?.length) {
      continue;
    }

    for (const functionCall of functionCalls) {
      if (functionCall.id && functionResponsesIds.has(functionCall.id)) {
        functionCallEventIdx = idx;
        const functionCallIds = new Set<string>(
            functionCalls.map(fc => fc.id).filter((id): id is string => !!id),
        );

        // Check if functionResponsesIds is a subset of functionCallIds
        const isSubset = Array.from(functionResponsesIds)
                             .every(id => functionCallIds.has(id));

        if (!isSubset) {
          throw new Error(
              'Last response event should only contain the responses for the' +
                  ' function calls in the same function call event. Function' +
                  ` call ids found : ${
                      Array.from(functionCallIds)
                          .join(', ')}, function response` +
                  ` ids provided: ${
                      Array.from(functionResponsesIds).join(', ')}`,
          );
        }
        // Expand the function call events to collect all function responses
        // from the function call event to the last response event.
        // TODO - b/425992518: bad practice, state can mutated multiple times.
        functionResponsesIds = functionCallIds;
        break;
      }
    }
  }

  if (functionCallEventIdx === -1) {
    throw new Error(
        `No function call event found for function responses ids: ${
            Array
                .from(
                    functionResponsesIds,
                    )
                .join(', ')}`,
    );
  }

  // Collect all function response events between the function call event
  // and the last function response event
  const functionResponseEvents: Event[] = [];
  for (let idx = functionCallEventIdx + 1; idx < events.length - 1; idx++) {
    const event = events[idx];
    const responses = event.getFunctionResponses();
    if (responses &&
        responses.some(
            (response) =>
                response.id && functionResponsesIds.has(response.id))) {
      functionResponseEvents.push(event);
    }
  }
  functionResponseEvents.push(events[events.length - 1]);

  const resultEvents = events.slice(0, functionCallEventIdx + 1);
  resultEvents.push(mergeFunctionResponseEvents(functionResponseEvents));

  return resultEvents;
}

/**
 * Rearrange the events for the latest function_response.
 *
 * If the latest function_response is for an async function_call, all events
 * between the initial function_call and the latest function_response will be
 * removed.
 *
 * @param event: A list of events.
 *
 * @returns A list of events with the latest function_response rearranged.
 */
function rearrangeEventsForAsyncFunctionResponsesInHistory(
    events: Event[],
    ): Event[] {
  const functionCallIdToResponseEventIndex: Map<string, number> = new Map();

  // First pass: Map function_call_id to the index of their
  // corresponding response events.
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const functionResponses = event.getFunctionResponses();
    if (functionResponses?.length) {
      for (const functionResponse of functionResponses) {
        if (!functionResponse.id) {
          continue;
        }

        functionCallIdToResponseEventIndex.set(functionResponse.id, i);
      }
    }
  }

  const resultEvents: Event[] = [];

  // Second pass: Build the new ordered list of events.
  for (const event of events) {
    // If the event contains function responses, it will be handled when
    // its corresponding function_call is encountered, so skip it for now.
    if (event.getFunctionResponses().length > 0) {
      continue;
    }

    const functionCalls = event.getFunctionCalls();
    if (functionCalls?.length) {
      const functionResponseEventsIndices: Set<number> = new Set();
      for (const functionCall of functionCalls) {
        const functionCallId = functionCall.id;
        if (functionCallId &&
            functionCallIdToResponseEventIndex.has(functionCallId)) {
          functionResponseEventsIndices.add(
              functionCallIdToResponseEventIndex.get(functionCallId)!,
          );
        }
      }

      resultEvents.push(event);

      if (functionResponseEventsIndices.size === 0) {
        continue;
      }

      if (functionResponseEventsIndices.size === 1) {
        const [responseIndex] = [...functionResponseEventsIndices];
        resultEvents.push(events[responseIndex]);
      } else {
        const indicesArray =
            Array.from(functionResponseEventsIndices).sort((a, b) => a - b);
        const eventsToMerge = indicesArray.map((index) => events[index]);
        resultEvents.push(mergeFunctionResponseEvents(eventsToMerge));
      }
    } else {
      resultEvents.push(event);
    }
  }

  return resultEvents;
}
