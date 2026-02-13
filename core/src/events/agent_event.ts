/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse} from '@google/genai';

/**
 * Represents a reasoning trace (thought) from the agent.
 */
export interface AgentThoughtEvent {
  type: 'thought';
  content: string;
}

/**
 * Represents partial content (text delta) intended for the user.
 */
export interface AgentContentEvent {
  type: 'content';
  content: string;
}

/**
 * Represents a request to execute a tool.
 */
export interface AgentToolCallEvent {
  type: 'tool_call';
  call: FunctionCall;
}

/**
 * Represents the result of a tool execution.
 */
export interface AgentToolResultEvent {
  type: 'tool_result';
  result: FunctionResponse;
}

/**
 * Represents a runtime error.
 */
export interface AgentErrorEvent {
  type: 'error';
  error: Error;
}

/**
 * Represents a generic activity or status update.
 */
export interface AgentActivityEvent {
  type: 'activity';
  kind: string;
  detail: Record<string, unknown>;
}

/**
 * Represents the final completion of the agent's task.
 */
export interface AgentFinishedEvent {
  type: 'finished';
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
