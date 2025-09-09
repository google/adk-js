/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse} from '@google/genai';

import {LlmResponse} from '../models/llm_response.js';

import {createEventActions, EventActions} from './event_actions.js';

/**
 * Represents an event in a conversation between agents and users.

  It is used to store the content of the conversation, as well as the actions
  taken by the agents like function calls, etc.
 */
export interface Event extends LlmResponse {
  /**
   * The unique identifier of the event.
   * Do not assign the ID. It will be assigned by the session.
   */
  id: string;

  /**
   * The invocation ID of the event. Should be non-empty before appending to a
   * session.
   */
  invocationId: string;

  /**
   * "user" or the name of the agent, indicating who appended the event to the
   * session.
   */
  author?: string;

  /**
   * The actions taken by the agent.
   */
  actions: EventActions;

  /**
   * Set of ids of the long running function calls. Agent client will know from
   * this field about which function call is long running. Only valid for
   * function call event
   */
  longRunningToolIds?: string[];

  /**
   * The branch of the event.
   * The format is like agent_1.agent_2.agent_3, where agent_1 is the parent of
   * agent_2, and agent_2 is the parent of agent_3.
   *
   * Branch is used when multiple sub-agent shouldn't see their peer agents'
   * conversation history.
   */
  branch?: string;

  /**
   * The timestamp of the event.
   */
  timestamp: number;
}

/**
 * Creates an event from a partial event.
 *
 * @param params The partial event to create the event from.
 * @returns The event.
 */
export function createEvent(params: Partial<Event> = {}): Event {
  return {
    ...params,
    id: params.id || createNewEventId(),
    invocationId: params.invocationId || '',
    author: params.author,
    actions: params.actions || createEventActions(),
    longRunningToolIds: params.longRunningToolIds || [],
    branch: params.branch,
    timestamp: params.timestamp || Date.now(),
  };
}

/**
 * Returns whether the event is the final response of the agent.
 */
export function isFinalResponse(event: Event) {
  if (event.actions.skipSummarization ||
      (event.longRunningToolIds && event.longRunningToolIds.length > 0)) {
    return true;
  }

  return (
      getFunctionCalls(event).length === 0 &&
      getFunctionResponses(event).length === 0 && !event.partial &&
      !hasTrailingCodeExecutionResult(event));
}

/**
 * Returns the function calls in the event.
 */
export function getFunctionCalls(event: Event): FunctionCall[] {
  const funcCalls = [];
  if (event.content && event.content.parts) {
    for (const part of event.content.parts) {
      if (part.functionCall) {
        funcCalls.push(part.functionCall);
      }
    }
  }

  return funcCalls;
}

/**
 * Returns the function responses in the event.
 */
export function getFunctionResponses(event: Event): FunctionResponse[] {
  const funcResponses = [];
  if (event.content && event.content.parts) {
    for (const part of event.content.parts) {
      if (part.functionResponse) {
        funcResponses.push(part.functionResponse);
      }
    }
  }

  return funcResponses;
}

/**
 * Returns whether the event has a trailing code execution result.
 */
export function hasTrailingCodeExecutionResult(event: Event): boolean {
  if (event.content && event.content.parts?.length) {
    const lastPart = event.content.parts[event.content.parts.length - 1];
    return lastPart.codeExecutionResult !== undefined;
  }

  return false;
}

const ASCII_LETTERS_AND_NUMBERS =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a new unique ID for the event.
 */
export function createNewEventId(): string {
  let id = '';

  for (let i = 0; i < 8; i++) {
    id += ASCII_LETTERS_AND_NUMBERS[Math.floor(
        Math.random() * ASCII_LETTERS_AND_NUMBERS.length)];
  }

  return id;
}