/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse,} from '@google/genai';

import {LlmResponse} from '../models/llm_response.js';

import {EventActions} from './event_actions.js';

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

/**
 * Represents an event in a conversation between agents and users.

  It is used to store the content of the conversation, as well as the actions
  taken by the agents like function calls, etc.
 */
export class Event extends LlmResponse {
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

  constructor(params: Partial<Event> = {}) {
    super(params);
    this.id = params.id || createNewEventId();
    this.invocationId = params.invocationId || '';
    this.author = params.author;
    this.actions = params.actions || new EventActions();
    this.longRunningToolIds = params.longRunningToolIds || [];
    this.branch = params.branch;
    this.timestamp = params.timestamp || Date.now();
  }

  /**
   * Returns whether the event is the final response of the agent.
   */
  isFinalResponse() {
    if (this.actions.skipSummarization ||
        (this.longRunningToolIds && this.longRunningToolIds.length > 0)) {
      return true;
    }

    return (
        this.getFunctionCalls().length === 0 &&
        this.getFunctionResponses().length === 0 && !this.partial &&
        !this.hasTrailingCodeExecutionResult());
  }

  /**
   * Returns the function calls in the event.
   */
  getFunctionCalls(): FunctionCall[] {
    const funcCalls = [];
    if (this.content && this.content.parts) {
      for (const part of this.content.parts) {
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
  getFunctionResponses(): FunctionResponse[] {
    const funcResponses = [];
    if (this.content && this.content.parts) {
      for (const part of this.content.parts) {
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
  hasTrailingCodeExecutionResult(): boolean {
    if (this.content && this.content.parts?.length) {
      const lastPart = this.content.parts[this.content.parts.length - 1];
      return lastPart.codeExecutionResult !== undefined;
    }

    return false;
  }
}
