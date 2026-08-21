/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isPlainObject} from 'lodash-es';

import {AuthConfig} from '../auth/auth_tool.js';
import {
  carryBlendedDeltaStamp,
  carryDeltaStamp,
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
 * Stores `key` as an own data property. State values are caller-controlled
 * JSON, and on a plain object `obj[key] = value` with an own `__proto__` key
 * invokes the inherited setter — the entry is silently dropped and the object
 * is re-parented with the value. `defineProperty` always creates an own
 * property. See `updateSessionState`/`trimTempDeltaState` in
 * `base_session_service.ts`, which harden the same class of write.
 */
function setOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Recursively merges two `stateDelta` values, mirroring Python ADK's
 * `deep_merge_dicts` (flows/llm_flows/functions.py): plain objects merge
 * key-by-key, everything else — arrays included — is overwritten by the later
 * value. Copies at each level instead of mutating, so the source events'
 * deltas stay intact.
 *
 * Merged copies are ordinary plain objects — state values must keep
 * `Object.prototype` (`hasOwnProperty`, template interpolation) because they
 * are stored verbatim into `session.state`. Pollution safety comes from
 * `setOwnProperty` and own-property reads: a caller-supplied `__proto__` key
 * is stored and read as an own entry, never through the inherited setter or
 * the prototype chain. A self-referencing `incoming` value — already illegal
 * for state, which must stay JSON-serializable — degrades to
 * last-writer-wins instead of exhausting the call stack.
 */
function deepMergeStateValues(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  merging: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
  merging.add(incoming);
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    setOwnProperty(merged, key, base[key]);
  }
  for (const key of Object.keys(incoming)) {
    const value = incoming[key];
    // Own-property read: `merged[key]` for a not-yet-set `__proto__` key
    // would resolve `Object.prototype` through the prototype chain and
    // phantom-merge against it.
    const existing = Object.hasOwn(merged, key) ? merged[key] : undefined;
    const mergeable =
      isPlainObject(existing) &&
      isPlainObject(value) &&
      !merging.has(value as object);
    setOwnProperty(
      merged,
      key,
      mergeable
        ? deepMergeStateValues(
            existing as Record<string, unknown>,
            value as Record<string, unknown>,
            merging,
          )
        : value,
    );
  }
  merging.delete(incoming);
  return merged;
}

/**
 * Merges a list of {@link EventActions} objects into a single
 * {@link EventActions} object.
 *
 * Merge semantics:
 * 1. **`stateDelta`** — entries from every source are combined key-by-key.
 *    When both sides of a duplicate key hold plain objects they are
 *    recursively deep-merged, mirroring Python ADK's `deep_merge_dicts`;
 *    anything else — arrays included — is last-writer-wins.
 * 2. **`artifactDelta`** — combined per filename; on a duplicate filename
 *    (parallel siblings saving the same artifact) the highest version wins,
 *    since versions increase in completion order and the newest is the
 *    surviving payload.
 * 3. **Other dictionary fields** (`requestedAuthConfigs`,
 *    `requestedToolConfirmations`) — combined via `Object.assign`; keys are
 *    unique function-call ids, so duplicates cannot collide in practice.
 * 4. **Scalar fields** (`skipSummarization`, `transferToAgent`, `escalate`) —
 *    last-writer-wins: the value from the last source that sets the field is
 *    kept.
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

  if (target) {
    Object.assign(result, target);
  }

  for (const source of sources) {
    if (!source) continue;

    if (source.stateDelta) {
      for (const key of Object.keys(source.stateDelta)) {
        const incoming = source.stateDelta[key];
        // Own-property read — see deepMergeStateValues: a first-seen
        // `__proto__` key must not resolve `Object.prototype` as `existing`.
        const existing = Object.hasOwn(result.stateDelta, key)
          ? result.stateDelta[key]
          : undefined;
        if (isPlainObject(existing) && isPlainObject(incoming)) {
          setOwnProperty(
            result.stateDelta,
            key,
            deepMergeStateValues(
              existing as Record<string, unknown>,
              incoming as Record<string, unknown>,
            ),
          );
          // The blend subsumes both contributing writes, so it must carry a
          // stamp that beats both — otherwise a commit could skip it as stale.
          carryBlendedDeltaStamp(source.stateDelta, result.stateDelta, key);
        } else {
          setOwnProperty(result.stateDelta, key, incoming);
          // The merged map is a new object; carry the write order with the
          // entry so a late commit can still tell it has been superseded.
          carryDeltaStamp(source.stateDelta, result.stateDelta, key);
        }
      }
    }
    if (source.artifactDelta) {
      for (const key of Object.keys(source.artifactDelta)) {
        const version = source.artifactDelta[key];
        const existing = Object.hasOwn(result.artifactDelta, key)
          ? result.artifactDelta[key]
          : undefined;
        // Parallel sibling saves to one filename draw distinct increasing
        // versions in completion order, which need not match input order —
        // keep the newest so the event records the surviving payload.
        setOwnProperty(
          result.artifactDelta,
          key,
          existing !== undefined && existing > version ? existing : version,
        );
      }
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

    if (source.skipSummarization !== undefined) {
      result.skipSummarization = source.skipSummarization;
    }
    if (source.transferToAgent !== undefined) {
      result.transferToAgent = source.transferToAgent;
    }
    if (source.escalate !== undefined) {
      result.escalate = source.escalate;
    }
  }
  return result;
}
