/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {experimental} from '../utils/experimental.js';
import {BaseAgent, BaseAgentConfig} from './base_agent.js';
import {InvocationContext} from './invocation_context.js';

const DEFAULT_REMOTE_AGENT_TIMEOUT_MS = 120_000;
const MILLIS_PER_SECOND = 1000;

const SESSION_PRESERVE_KEYS: ReadonlySet<string> = new Set(['state', 'events']);

const EVENT_PRESERVE_KEYS: ReadonlySet<string> = new Set([
  'actions.state_delta',
  'actions.artifact_delta',
  'actions.requested_auth_configs',
  'actions.requested_tool_confirmations',
  'actions.custom_metadata',
  'custom_metadata',
  'content.parts.function_call.args',
  'content.parts.function_response.response',
  'output',
  'route',
  'actions.agent_state',
]);

/**
 * Custom `fetch` function signature accepted by {@link RemoteAgentConfig.fetchImpl}.
 */
export type RemoteAgentFetch = typeof fetch;

/**
 * Configuration options for {@link RemoteAgent}.
 */
export interface RemoteAgentConfig extends BaseAgentConfig {
  /**
   * Remote HTTP endpoint URL that accepts an invocation payload and returns a JSON array of events.
   */
  url: string;

  /**
   * Request timeout in milliseconds; defaults to `120_000` (120 seconds).
   */
  timeoutMs?: number;

  /**
   * Optional custom `fetch` implementation used for HTTP requests.
   */
  fetchImpl?: RemoteAgentFetch;

  /**
   * Sub-agents are disabled on {@link RemoteAgent}.
   */
  subAgents?: never;
}

const REMOTE_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.remoteAgent');

/**
 * Type guard to check if an object is an instance of {@link RemoteAgent}.
 *
 * @param obj The object to check.
 * @returns True if the object is an instance of {@link RemoteAgent}.
 */
export function isRemoteAgent(obj: unknown): obj is RemoteAgent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    REMOTE_AGENT_SIGNATURE_SYMBOL in obj &&
    obj[REMOTE_AGENT_SIGNATURE_SYMBOL] === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively clones a JSON-serializable value while omitting schema properties
 * whose values are `null` or `undefined`, preserving arbitrary user-data
 * subtrees listed in `preserveKeys`.
 */
function stripNullish(
  value: unknown,
  preserveKeys: ReadonlySet<string>,
  parentKey = '',
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNullish(item, preserveKeys, parentKey));
  }
  if (value !== null && typeof value === 'object') {
    return stripNullishRecord(value, preserveKeys, parentKey);
  }
  return value;
}

function stripNullishRecord(
  record: object,
  preserveKeys: ReadonlySet<string>,
  parentKey = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (entryValue === undefined || entryValue === null) {
      continue;
    }
    const fullPath = parentKey !== '' ? `${parentKey}.${key}` : key;
    result[key] = preserveKeys.has(fullPath)
      ? entryValue
      : stripNullish(entryValue, preserveKeys, fullPath);
  }
  return result;
}

function serializeEventToSnakeCase(event: Event): Record<string, unknown> {
  const snakeEvent = transformToSnakeCaseEvent(event);
  snakeEvent['timestamp'] = event.timestamp / MILLIS_PER_SECOND;
  return stripNullishRecord(snakeEvent, EVENT_PRESERVE_KEYS);
}

/**
 * Serializes a {@link Session} to `snake_case` wire format with `null` and
 * `undefined` schema fields omitted and timestamps converted from milliseconds
 * to seconds.
 */
function serializeSessionToSnakeCase(
  session: Session,
): Record<string, unknown> {
  return stripNullishRecord(
    {
      id: session.id,
      app_name: session.appName,
      user_id: session.userId,
      state: session.state,
      events: session.events.map((event) => serializeEventToSnakeCase(event)),
      last_update_time: session.lastUpdateTime / MILLIS_PER_SECOND,
    },
    SESSION_PRESERVE_KEYS,
  );
}

/**
 * Experimental agent that forwards invocation context and session state to a
 * remote HTTP endpoint.
 *
 * Trust assumption: returned event payloads (including `id`, `timestamp`, and
 * `actions` such as `stateDelta`, `artifactDelta`, `transferToAgent`, and
 * `escalate`) are deserialized via `transformToCamelCaseEvent` and passed
 * to {@link createEvent} without schema or authorization filtering; only
 * `author` is overwritten with this agent's `name`. Configure `url` only with a
 * trusted remote endpoint.
 */
@experimental
export class RemoteAgent extends BaseAgent<RemoteAgentConfig> {
  readonly [REMOTE_AGENT_SIGNATURE_SYMBOL] = true;

  /**
   * Remote HTTP endpoint URL.
   */
  readonly url: string;

  /**
   * Request timeout in milliseconds.
   */
  readonly timeoutMs: number;

  private readonly fetchImpl: RemoteAgentFetch;

  constructor(config: RemoteAgentConfig) {
    const runtimeSubAgents: unknown = config.subAgents;
    if (
      Array.isArray(runtimeSubAgents)
        ? runtimeSubAgents.length > 0
        : Boolean(runtimeSubAgents)
    ) {
      throw new Error('subAgents is disabled in RemoteAgent.');
    }
    super({...config, subAgents: []});
    this.url = config.url;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_REMOTE_AGENT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const data = {
      invocation_id: ctx.invocationId,
      session: serializeSessionToSnakeCase(ctx.session),
    };

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx.abortSignal
      ? AbortSignal.any([ctx.abortSignal, timeoutSignal])
      : timeoutSignal;

    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data),
      signal,
    });

    if (response.status >= 400) {
      throw new Error(
        `RemoteAgent request to '${this.url}' failed with HTTP status ${response.status}.`,
      );
    }

    const rawEvents: unknown = await response.json();
    if (!Array.isArray(rawEvents)) {
      throw new Error(
        `RemoteAgent expected a JSON array of events from '${this.url}'.`,
      );
    }

    for (const rawEvent of rawEvents) {
      if (!isRecord(rawEvent)) {
        throw new Error(
          `RemoteAgent expected each item in the response from '${this.url}' to be a JSON event object.`,
        );
      }
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const camelEvent = transformToCamelCaseEvent(rawEvent);
      const invocationId =
        camelEvent.invocationId !== undefined && camelEvent.invocationId !== ''
          ? camelEvent.invocationId
          : ctx.invocationId;
      const timestamp =
        typeof camelEvent.timestamp === 'number'
          ? camelEvent.timestamp * MILLIS_PER_SECOND
          : undefined;
      yield createEvent({
        ...camelEvent,
        invocationId,
        timestamp,
        author: this.name,
      });
    }
  }

  protected override async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
    throw new Error('This is not supported yet for RemoteAgent.');
  }
}
