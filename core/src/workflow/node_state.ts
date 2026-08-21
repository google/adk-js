/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NodeStatus} from './node_status.js';

/**
 * State of a node in the workflow.
 *
 * Ported from `google/adk-python` `workflow/_node_state.py`. Note that the
 * node's *output* is intentionally NOT stored here — it is carried on emitted
 * events / the node Context, not on the persisted node state.
 */
export interface NodeState {
  /** The run status of the node. */
  status: NodeStatus;

  /** The input provided to the node. */
  input?: unknown;

  /** The attempt count for this node run (1-based). */
  attemptCount: number;

  /** The interrupt ids that are pending to be resolved. */
  interrupts: string[];

  /** The responses for resuming the node, keyed by interrupt id. */
  resumeInputs: Record<string, unknown>;

  /**
   * Sequential counter incremented each time the node gets a fresh run.
   *
   * Preserving this count independently of `runId` prevents path collisions if
   * a node switches between custom string IDs and auto-generated numeric IDs.
   */
  runCounter: number;

  /** The run ID of this node run. */
  runId?: string;

  /**
   * The run ID of the parent node which dynamically scheduled this node run.
   */
  parentRunId?: string;
}

/**
 * Creates a {@link NodeState} with Python-aligned defaults, overlaying any
 * provided partial values.
 */
export function createNodeState(partial?: Partial<NodeState>): NodeState {
  return {
    status: NodeStatus.INACTIVE,
    attemptCount: 1,
    interrupts: [],
    resumeInputs: {},
    runCounter: 0,
    ...partial,
  };
}

/**
 * Type guard for a {@link NodeState}-shaped object.
 */
export function isNodeState(obj: unknown): obj is NodeState {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'status' in obj &&
    typeof (obj as NodeState).status === 'number' &&
    'attemptCount' in obj &&
    'interrupts' in obj &&
    Array.isArray((obj as NodeState).interrupts)
  );
}
