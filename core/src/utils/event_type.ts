/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse} from '@google/genai';
import {Event} from '../events/event.js';

/**
 * The types of events that can be parsed from a raw Event.
 */
export enum EventType {
  THOUGHT = 'thought',
  CONTENT = 'content',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  ERROR = 'error',
  ACTIVITY = 'activity',
  FINISHED = 'finished',
}

/**
 * Represents a reasoning trace (thought) from the agent.
 */
export interface ThoughtEvent {
  type: EventType.THOUGHT;
  content: string;
}

/**
 * Represents partial content (text delta) intended for the user.
 */
export interface ContentEvent {
  type: EventType.CONTENT;
  content: string;
}

/**
 * Represents a request to execute a tool.
 */
export interface ToolCallEvent {
  type: EventType.TOOL_CALL;
  call: FunctionCall;
}

/**
 * Represents the result of a tool execution.
 */
export interface ToolResultEvent {
  type: EventType.TOOL_RESULT;
  result: FunctionResponse;
}

/**
 * Represents a runtime error.
 */
export interface ErrorEvent {
  type: EventType.ERROR;
  error: Error;
}

/**
 * Represents a generic activity or status update.
 */
export interface ActivityEvent {
  type: EventType.ACTIVITY;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * Represents the final completion of the agent's task.
 */
export interface FinishedEvent {
  type: EventType.FINISHED;
  output: unknown;
}

/**
 * A standard structured event parsed from the raw Event stream.
 */
export type StructuredEvent =
  | ThoughtEvent
  | ContentEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | ActivityEvent
  | FinishedEvent;

/**
 * Converts an internal Event to a structured Event stream.
 * This is an optional utility for callers who want to easily identify
 * the type of event they are handling.
 *
 * @param event - The raw event to convert.
 * @yields The structured event stream.
 */
export function* parseEvent(event: Event): IterableIterator<StructuredEvent> {
  if (event.content?.role === 'system' && event.content.parts?.[0]?.text) {
    yield {
      type: EventType.ERROR,
      error: new Error(`Agent error: ${event.content.parts[0].text}`),
    };
    return;
  }

  for (const part of event.content?.parts ?? []) {
    if (part.functionCall) {
      yield {type: EventType.TOOL_CALL, call: part.functionCall};
    } else if (part.functionResponse) {
      yield {
        type: EventType.TOOL_RESULT,
        result: part.functionResponse,
      };
    } else if (part.text) {
      if (part.thought) {
        yield {type: EventType.THOUGHT, content: part.text};
      } else {
        yield {type: EventType.CONTENT, content: part.text};
      }
    }
  }

  if (event.actions) {
    yield {
      type: EventType.ACTIVITY,
      kind: 'actions',
      detail: {actions: event.actions},
    };
  }

  if (event.content?.role === 'model' && event.content.parts?.length === 0) {
    yield {type: EventType.FINISHED, output: null};
  }
}
