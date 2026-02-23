/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionResult,
  ExecutableCode,
  FunctionCall,
  FunctionResponse,
} from '@google/genai';
import {isEmpty} from 'lodash-es';
import {Event, isFinalResponse} from './event.js';

/**
 * The types of events that can be parsed from a raw Event.
 */
export enum EventType {
  THOUGHT = 'thought',
  CONTENT = 'content',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  CALL_CODE = 'call_code',
  CODE_RESULT = 'code_result',
  ERROR = 'error',
  ACTIVITY = 'activity',
  TOOL_CONFIRMATION = 'tool_confirmation',
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
 * Represents a request to execute code.
 */
export interface CallCodeEvent {
  type: EventType.CALL_CODE;
  code: ExecutableCode;
}

/**
 * Represents the result of code execution.
 */
export interface CodeResultEvent {
  type: EventType.CODE_RESULT;
  result: CodeExecutionResult;
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
 * Represents a request for tool confirmation.
 */
export interface ToolConfirmationEvent {
  type: EventType.TOOL_CONFIRMATION;
  confirmations: Record<string, unknown>;
}

/**
 * Represents the final completion of the agent's task.
 */
export interface FinishedEvent {
  type: EventType.FINISHED;
  output?: unknown;
}

/**
 * A standard structured event parsed from the raw Event stream.
 */
export type StructuredEvent =
  | ThoughtEvent
  | ContentEvent
  | ToolCallEvent
  | ToolResultEvent
  | CallCodeEvent
  | CodeResultEvent
  | ErrorEvent
  | ActivityEvent
  | ToolConfirmationEvent
  | FinishedEvent;

/**
 * Converts an internal Event to a list of structured events.
 * This is an optional utility for callers who want to easily identify
 * the type of event they are handling.
 *
 * @param event - The raw event to convert.
 * @returns The structured events.
 */
export function toStructuredEvents(event: Event): StructuredEvent[] {
  const structuredEvents: StructuredEvent[] = [];

  if (event.errorCode) {
    structuredEvents.push({
      type: EventType.ERROR,
      error: new Error(event.errorMessage || event.errorCode),
    });
    return structuredEvents;
  }

  for (const part of event.content?.parts ?? []) {
    if (part.functionCall && !isEmpty(part.functionCall)) {
      structuredEvents.push({
        type: EventType.TOOL_CALL,
        call: part.functionCall,
      });
    } else if (part.functionResponse && !isEmpty(part.functionResponse)) {
      structuredEvents.push({
        type: EventType.TOOL_RESULT,
        result: part.functionResponse,
      });
    } else if (part.executableCode && !isEmpty(part.executableCode)) {
      structuredEvents.push({
        type: EventType.CALL_CODE,
        code: part.executableCode,
      });
    } else if (part.codeExecutionResult && !isEmpty(part.codeExecutionResult)) {
      structuredEvents.push({
        type: EventType.CODE_RESULT,
        result: part.codeExecutionResult,
      });
    } else if (part.text) {
      if (part.thought) {
        structuredEvents.push({type: EventType.THOUGHT, content: part.text});
      } else {
        structuredEvents.push({type: EventType.CONTENT, content: part.text});
      }
    }
  }

  if (
    event.actions.requestedToolConfirmations &&
    !isEmpty(event.actions.requestedToolConfirmations)
  ) {
    structuredEvents.push({
      type: EventType.TOOL_CONFIRMATION,
      confirmations: event.actions.requestedToolConfirmations as Record<
        string,
        unknown
      >,
    });
  }

  if (isFinalResponse(event)) {
    structuredEvents.push({type: EventType.FINISHED, output: undefined});
  }

  return structuredEvents;
}
