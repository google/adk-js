/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse} from '@google/genai';

/**
 * The types of events that can be emitted by the agent.
 */
export enum AgentEventType {
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
export interface AgentThoughtEvent {
  type: AgentEventType.THOUGHT;
  content: string;
}

/**
 * Represents partial content (text delta) intended for the user.
 */
export interface AgentContentEvent {
  type: AgentEventType.CONTENT;
  content: string;
}

/**
 * Represents a request to execute a tool.
 */
export interface AgentToolCallEvent {
  type: AgentEventType.TOOL_CALL;
  call: FunctionCall;
}

/**
 * Represents the result of a tool execution.
 */
export interface AgentToolResultEvent {
  type: AgentEventType.TOOL_RESULT;
  result: FunctionResponse;
}

/**
 * Represents a runtime error.
 */
export interface AgentErrorEvent {
  type: AgentEventType.ERROR;
  error: Error;
}

/**
 * Represents a generic activity or status update.
 */
export interface AgentActivityEvent {
  type: AgentEventType.ACTIVITY;
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * Represents the final completion of the agent's task.
 */
export interface AgentFinishedEvent {
  type: AgentEventType.FINISHED;
  output: unknown;
}

/**
 * A standard event emitted by the Agent Runner stream.
 */
export type AgentEvent =
  | AgentThoughtEvent
  | AgentContentEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentErrorEvent
  | AgentActivityEvent
  | AgentFinishedEvent;
