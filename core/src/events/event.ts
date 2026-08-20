/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, FunctionResponse} from '@google/genai';

import {LlmResponse} from '../models/llm_response.js';

import {randomUUID} from '../utils/env_aware_utils.js';
import {toCamelCase, toSnakeCase} from '../utils/object_notation_utils.js';
import {createEventActions, EventActions} from './event_actions.js';

/**
 * A unique symbol identifying ADK Event objects.
 *
 * Events are plain objects produced by {@link createEvent} rather than class
 * instances, so they carry this signature as a brand and `isEvent` checks for
 * it — mirroring the `Symbol.for('google.adk.*')` guards used across ADK (e.g.
 * `isBaseTool`, `isBaseAgent`).
 */
const EVENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.event');

/**
 * A single route key emitted by a routing node and matched against graph edge
 * routes. Mirrors the graph's `RouteValue`.
 */
export type RouteKey = string | number | boolean;

/**
 * The route(s) a routing node emits: a single key fires one branch; an array
 * fires every branch whose route matches any listed key (multi-route dispatch).
 */
export type Route = RouteKey | RouteKey[];

/**
 * Workflow-node provenance attached to an event.
 *
 * Mirrors `google/adk-python` `Event.node_info`. Present only on events emitted
 * from within a workflow node.
 */
export interface NodeInfo {
  /** The workflow node path that produced this event (e.g. `wf.child.0`). */
  path?: string;

  /**
   * The node paths this event's output serves as the output for: the emitting
   * node first, then any ancestor that delegated its own output to it.
   *
   * A node that runs a child with `useAsOutput` takes the child's output as its
   * own, so one event is the result for several nodes at once. Recording that
   * on the event is what lets a resumed run tell which nodes already produced a
   * result, instead of re-running an ancestor whose output only ever existed on
   * a descendant's event.
   *
   * Mirrors adk-python's `node_info.output_for`, which is likewise a list.
   */
  outputFor?: string[];

  /**
   * Whether the event's textual content should be promoted to the node's
   * structured output.
   */
  messageAsOutput?: boolean;
}

/**
 * Represents an event in a conversation between agents and users.

  It is used to store the content of the conversation, as well as the actions
  taken by the agents like function calls, etc.
 */
export interface Event extends LlmResponse {
  /**
   * Signature brand identifying this object as an ADK {@link Event}.
   *
   * Set by {@link createEvent} and checked by `isEvent`. Optional because
   * events are also reconstructed from storage/session payloads, where the
   * (non-serializable) brand is absent.
   */
  readonly [EVENT_SIGNATURE_SYMBOL]?: true;

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

  /**
   * Workflow: the structured output produced by the emitting node, if any.
   *
   * First-class field mirroring `google/adk-python` `Event.output`. Used by the
   * workflow engine to carry a node's return value alongside its content.
   */
  output?: unknown;

  /**
   * Workflow: the route key(s) emitted by a routing node, used by the graph to
   * select the matching outgoing edge(s). A single value fires one branch; an
   * array fires every branch whose route matches any listed value (multi-route
   * dispatch). Mirrors Python `Event.route`.
   */
  route?: Route;

  /**
   * Workflow: provenance of the emitting node. Mirrors Python `Event.node_info`.
   */
  nodeInfo?: NodeInfo;

  /**
   * Workflow: scope tag used to isolate multi-agent conversations so peer
   * scopes don't see each other's events. Mirrors Python
   * `Event.isolation_scope`.
   */
  isolationScope?: string;
}

/**
 * Parameters for creating an event with partial fields.
 */
export interface CreateEventParams extends Omit<Partial<Event>, 'actions'> {
  actions?: Partial<EventActions>;
}

/**
 * Creates an event from a partial event.
 *
 * @param params The partial event to create the event from.
 * @returns The event.
 */
export function createEvent(params: CreateEventParams = {}): Event {
  return {
    ...params,
    [EVENT_SIGNATURE_SYMBOL]: true,
    id: params.id || createNewEventId(),
    invocationId: params.invocationId || '',
    author: params.author,
    actions: createEventActions(params.actions),
    longRunningToolIds: params.longRunningToolIds || [],
    branch: params.branch,
    timestamp: params.timestamp || Date.now(),
  };
}

/**
 * Returns whether the event is the final response of the agent.
 */
export function isFinalResponse(event: Event) {
  if (
    event.actions.skipSummarization ||
    (event.longRunningToolIds && event.longRunningToolIds.length > 0) ||
    (event.actions.requestedAuthConfigs &&
      Object.keys(event.actions.requestedAuthConfigs).length > 0)
  ) {
    return true;
  }

  return (
    getFunctionCalls(event).length === 0 &&
    getFunctionResponses(event).length === 0 &&
    !event.partial &&
    !hasTrailingCodeExecutionResult(event)
  );
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

export const AF_FUNCTION_CALL_ID_PREFIX = 'adk-';

export function generateClientFunctionCallId(): string {
  return `${AF_FUNCTION_CALL_ID_PREFIX}${randomUUID()}`;
}

/**
 * Populates client-side function call IDs.
 *
 * It iterates through all function calls in the event and assigns a
 * unique client-side ID to each one that doesn't already have an ID.
 */
export function populateClientFunctionCallId(modelResponseEvent: Event): void {
  for (const functionCall of getFunctionCalls(modelResponseEvent)) {
    if (!functionCall.id) {
      functionCall.id = generateClientFunctionCallId();
    }
  }
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

/**
 * Extracts and concatenates all text from the parts of a `Event` object.
 * @param event The `Event` object to process.
 *
 * @returns A single string with the combined text.
 */
export function stringifyContent(event: Event): string {
  if (!event.content?.parts) {
    return '';
  }

  // Exclude thoughts from the context.
  return event.content.parts
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Estimates the number of tokens in the event based on usage metadata or characters.
 */
export function getEventTokens(event: Event): number {
  if (event.usageMetadata?.promptTokenCount !== undefined) {
    return event.usageMetadata.promptTokenCount;
  }
  // Estimate: 4 chars per token.
  const contentStr = stringifyContent(event);
  return Math.ceil(contentStr.length / 4);
}

/**
 * Returns whether the event contains any thought parts.
 */
export function hasThoughts(event: Event): boolean {
  return !!event.content?.parts?.some((part) => part.thought === true);
}

/**
 * Returns a copy of the event with all thought parts removed.
 */
export function pruneThoughts(event: Event): Event {
  if (!event.content?.parts) {
    return event;
  }
  const prunedParts = event.content.parts.filter(
    (part) => part.thought !== true,
  );

  return {
    ...event,
    content: {
      ...event.content,
      parts: prunedParts,
    },
  };
}

const ASCII_LETTERS_AND_NUMBERS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Type guard to check if an object is an instance of Event.
 *
 * @param obj The object to check.
 * @returns True if the object matches the Event structure.
 */
export function isEvent(obj: unknown): obj is Event {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    EVENT_SIGNATURE_SYMBOL in obj &&
    (obj as {[EVENT_SIGNATURE_SYMBOL]?: unknown})[EVENT_SIGNATURE_SYMBOL] ===
      true
  );
}

/**
 * Generates a new unique ID for the event.
 */
export function createNewEventId(): string {
  let id = '';

  for (let i = 0; i < 8; i++) {
    id +=
      ASCII_LETTERS_AND_NUMBERS[
        Math.floor(Math.random() * ASCII_LETTERS_AND_NUMBERS.length)
      ];
  }

  return id;
}

/**
 * List of keys to preserve during snake_case to camelCase conversion.
 *
 * Example: `content.parts.functionCall.args`
 * will be converted to be `content.parts.function_call.args` but the object
 * inside of the `content.parts.function_call.args` will skip the conversion as it
 * can contain data in any notation.
 */
const PRESERVE_KEYS_CAMEL_CASE = [
  'actions.stateDelta',
  'actions.artifactDelta',
  'actions.requestedAuthConfigs',
  'actions.requestedToolConfirmations',
  'actions.customMetadata',
  'customMetadata',
  'content.parts.functionCall.args',
  'content.parts.functionResponse.response',
  // Workflow: arbitrary node output, emitted route(s), and checkpointed node
  // state carry user-defined keys that must survive round-trips verbatim (a
  // node's original input is stashed under `actions.agentState` for HITL
  // resume, and rehydration reads `output`/`route`/`actions.agentState` back).
  'output',
  'route',
  'actions.agentState',
];

/**
 * List of keys to preserve during camelCase to snake_case conversion.
 *
 * Example: `content.parts.function_call.args`
 * will be converted to be `content.parts.functionCall.args` but the object
 * inside of the `content.parts.functionCall.args` will skip the conversion as it
 * can contain data in any notation.
 */
const PRESERVE_KEYS_SNAKE_CASE = [
  'actions.state_delta',
  'actions.artifact_delta',
  'actions.requested_auth_configs',
  'actions.requested_tool_confirmations',
  'actions.custom_metadata',
  'custom_metadata',
  'content.parts.function_call.args',
  'content.parts.function_response.response',
  // Workflow: arbitrary node output, emitted route(s), and checkpointed node
  // state (see the camelCase list above).
  'output',
  'route',
  'actions.agent_state',
];

/**
 * Transforms a snake_cased event object to a camelCased Event object.
 *
 * @param event The snake_cased event object.
 * @returns The camelCased Event object.
 */
export function transformToCamelCaseEvent(
  event: Record<string, unknown>,
): Event {
  return toCamelCase(event, PRESERVE_KEYS_SNAKE_CASE) as Event;
}

/**
 * Transforms a camelCased event object to a snake_cased Event object.
 *
 * @param event The camelCased event object.
 * @returns The snake_cased Event object.
 */
export function transformToSnakeCaseEvent(
  event: Event,
): Record<string, unknown> {
  return toSnakeCase(event, PRESERVE_KEYS_CAMEL_CASE) as Record<
    string,
    unknown
  >;
}
