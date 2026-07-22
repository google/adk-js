/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The status of a node in the workflow graph.
 *
 * Numeric values are aligned with `google/adk-python`
 * `workflow/_node_status.py` so that persisted node state is portable across
 * the Python and TypeScript runtimes.
 */
export enum NodeStatus {
  /** The node is not ready to be executed. */
  INACTIVE = 0,
  /** The node is ready to be executed. */
  PENDING = 1,
  /** The node is being executed. */
  RUNNING = 2,
  /** The node has been executed successfully. */
  COMPLETED = 3,
  /** The node is waiting (e.g. for a user response or re-trigger). */
  WAITING = 4,
  /** The node has failed. */
  FAILED = 5,
  /** The node has been cancelled. */
  CANCELLED = 6,
}
