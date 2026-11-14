/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEmpty} from 'lodash-es';

import {AuthConfig} from '../auth/auth_tool.js';
import {
  carryDeltaStamp,
  carryMergedDeltaStamp,
} from '../sessions/state_write_order.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';

/**
 * Represents the actions attached to an event.
 */
export interface EventActions {
  /**
   * If true, it won't call model to summarize function response.
   * Only used for function_response event.
   */
  skipSummarization?: boolean;

  /**
   * Indicates that the event is updating the state with the given delta.
   */
  stateDelta: {[key: string]: unknown};

  /**
   * Indicates that the event is updating an artifact. key is the filename,
   * value is the version.
   */
  artifactDelta: {[key: string]: number};

  /**
   * If set, the event transfers to the specified agent.
   */
  transferToAgent?: string;

  /**
   * The agent is escalating to a higher level agent.
   */
  escalate?: boolean;

  /**
   * Authentication configurations requested by tool responses.
   *
   * This field will only be set by a tool response event indicating tool
   * request auth credential.
   * - Keys: The function call id. Since one function response event could
   * contain multiple function responses that correspond to multiple function
   * calls. Each function call could request different auth configs. This id is
   * used to identify the function call.
   * - Values: The requested auth config.
   */
  requestedAuthConfigs: {[key: string]: AuthConfig};

  /**
   * A dict of tool confirmation requested by this event, keyed by the function
   * call id.
   */
  requestedToolConfirmations: {[key: string]: ToolConfirmation};

  /**
   * Workflow: a serialized node/agent state snapshot used for resumable
   * checkpointing. Mirrors Python `EventActions.agent_state`.
   */
  agentState?: Record<string, unknown>;

  /**
   * Workflow: marks that the emitting agent/workflow has reached the end of its
   * execution for this invocation. Mirrors Python `EventActions.end_of_agent`.
   */
  endOfAgent?: boolean;
}

/**
 * Creates an {@link EventActions} object with default empty-dict values for
 * all dictionary fields.
 *
 * @param state - Optional partial {@link EventActions} whose properties
 *   override the defaults. Dictionary fields (`stateDelta`, `artifactDelta`,
 *   `requestedAuthConfigs`, `requestedToolConfirmations`) default to `{}`;
 *   scalar fields (`skipSummarization`, `transferToAgent`, `escalate`) default
 *   to `undefined`.
 * @returns A fully populated {@link EventActions} object.
 */
export function createEventActions(
  state: Partial<EventActions> = {},
): EventActions {
  return {
    stateDelta: {},
    artifactDelta: {},
    requestedAuthConfigs: {},
    requestedToolConfirmations: {},
    ...state,
  };
}

/**
 * Returns whether the given {@link EventActions} still holds only its default
 * values, i.e. the event carries no state, artifact, auth, confirmation,
 * transfer, escalation, summarization, agent state, or end-of-agent signal.
 *
 * An actions object is considered non-default when any record field has at
 * least one entry, or when any scalar field has been explicitly set (including
 * being set to `false`).
 *
 * @param actions - The actions to inspect.
 * @returns `true` when every field is at its default value.
 */
export function isDefaultEventActions(actions: EventActions): boolean {
  return (
    isEmpty(actions.stateDelta) &&
    isEmpty(actions.artifactDelta) &&
    isEmpty(actions.requestedAuthConfigs) &&
    isEmpty(actions.requestedToolConfirmations) &&
    isEmpty(actions.agentState) &&
    actions.skipSummarization === undefined &&
    actions.transferToAgent === undefined &&
    actions.escalate === undefined &&
    actions.endOfAgent === undefined
  );
}

const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clonePlainRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (UNSAFE_MERGE_KEYS.has(key)) {
      continue;
    }
    const value = record[key];
    copy[key] = isPlainRecord(value) ? clonePlainRecord(value) : value;
  }
  return copy;
}

function deepMergeRecords(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = clonePlainRecord(base);
  for (const key of Object.keys(incoming)) {
    if (UNSAFE_MERGE_KEYS.has(key)) {
      continue;
    }
    const incomingValue = incoming[key];
    const existingValue = Object.hasOwn(merged, key) ? merged[key] : undefined;
    if (isPlainRecord(existingValue) && isPlainRecord(incomingValue)) {
      merged[key] = deepMergeRecords(existingValue, incomingValue);
    } else if (isPlainRecord(incomingValue)) {
      merged[key] = clonePlainRecord(incomingValue);
    } else {
      merged[key] = incomingValue;
    }
  }
  return merged;
}

function carryStateDeltaStamps(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(incoming, key)) {
      carryDeltaStamp(base, merged, key);
      continue;
    }
    if (
      Object.hasOwn(base, key) &&
      isPlainRecord(base[key]) &&
      isPlainRecord(incoming[key])
    ) {
      carryMergedDeltaStamp({base, incoming, to: merged, key});
    } else {
      carryDeltaStamp(incoming, merged, key);
    }
  }
}

/**
 * Merges a list of {@link EventActions} objects into a single
 * {@link EventActions} object without mutating `target` or any source.
 *
 * Merge semantics:
 * 1. **Flat record fields** (`artifactDelta`, `requestedAuthConfigs`,
 *    `requestedToolConfirmations`) — all entries from every source are combined
 *    with later sources winning on duplicate keys.
 * 2. **Nested record fields** (`stateDelta`, `agentState`) — nested plain
 *    objects are merged recursively; arrays and class instances are replaced.
 * 3. **Scalar fields** (`skipSummarization`, `transferToAgent`, `escalate`,
 *    `endOfAgent`) — last-writer-wins: the value from the last source that
 *    sets the field is kept.
 *
 * @param sources - Ordered list of partial {@link EventActions} to merge.
 *   Falsy entries are silently skipped.
 * @param target - Optional base {@link EventActions} to merge into. When
 *   provided it is used as the starting state before applying `sources`.
 * @returns A new {@link EventActions} containing the merged result.
 */
export function mergeEventActions(
  sources: Array<Partial<EventActions>>,
  target?: EventActions,
): EventActions {
  const result = createEventActions();
  const allSources = target ? [target, ...sources] : sources;

  for (const source of allSources) {
    if (!source) continue;

    if (source.stateDelta) {
      const mergedStateDelta = deepMergeRecords(
        result.stateDelta,
        source.stateDelta,
      );
      carryStateDeltaStamps(
        result.stateDelta,
        source.stateDelta,
        mergedStateDelta,
      );
      result.stateDelta = mergedStateDelta;
    }
    if (source.artifactDelta) {
      Object.assign(result.artifactDelta, source.artifactDelta);
    }
    if (source.requestedAuthConfigs) {
      Object.assign(result.requestedAuthConfigs, source.requestedAuthConfigs);
    }
    if (source.requestedToolConfirmations) {
      Object.assign(
        result.requestedToolConfirmations,
        source.requestedToolConfirmations,
      );
    }
    if (source.agentState) {
      result.agentState = deepMergeRecords(
        result.agentState ?? {},
        source.agentState,
      );
    }

    if (source.skipSummarization !== undefined) {
      result.skipSummarization = source.skipSummarization;
    }
    if (source.transferToAgent !== undefined) {
      result.transferToAgent = source.transferToAgent;
    }
    if (source.escalate !== undefined) {
      result.escalate = source.escalate;
    }
    if (source.endOfAgent !== undefined) {
      result.endOfAgent = source.endOfAgent;
    }
  }
  return result;
}
