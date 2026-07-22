/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A buffered trigger for a downstream node.
 *
 * Ported from `google/adk-python` `workflow/_trigger.py`. Unlike the previous
 * TypeScript `Trigger` (a route-matching predicate), this is a plain data record
 * describing *how* a target node should be invoked when its turn comes.
 */
export interface Trigger {
  /** The input to pass to the triggered node. */
  input?: unknown;

  /** Whether this trigger should run the node in an isolated sub-branch. */
  useSubBranch?: boolean;

  /** The branch inherited from the predecessor node. */
  branch?: string;

  /** Scope tag explicitly propagated to this trigger. */
  isolationScope?: string;
}
