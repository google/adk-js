/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseNode} from './base_node.js';
import type {NodeContext, NodeResult} from './node_context.js';
import {NodeState} from './node_state.js';

/**
 * Options for scheduling a dynamic node via {@link ScheduleDynamicNode}.
 */
export interface ScheduleDynamicNodeOptions {
  /** Deterministic tracking name; defaults to `node.name`. */
  nodeName?: string;
  /** Unique id for this specific execution (used for path/dedup keys). */
  runId: string;
  /** If true, the child's output replaces the caller's output. */
  useAsOutput?: boolean;
  /** If true, run the child in an isolated sub-branch. */
  useSubBranch?: boolean;
  /** Explicit branch override. */
  overrideBranch?: string;
  /** Explicit isolation-scope override. */
  overrideIsolationScope?: string;
}

/**
 * Protocol for scheduling a dynamically-invoked node (via `ctx.runNode()`).
 *
 * Implementations handle fresh execution, deduplication of concurrent calls,
 * and (Phase 5) resumption from session events. Ported from
 * `google/adk-python` `workflow/_schedule_dynamic_node.py`.
 */
export interface ScheduleDynamicNode {
  schedule(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext | NodeResult>;
}

/**
 * Combines state, output, and the running task for a single dynamic node
 * execution.
 */
export interface DynamicNodeRun {
  state: NodeState;
  output?: unknown;
  task?: Promise<NodeContext>;
  transferToAgent?: string;
  /**
   * The result of a run that completed without executing its body, kept so a
   * repeat call for the same path hands back the same result. Runs that did
   * execute are deduplicated by `task` instead.
   */
  result?: NodeResult;
}

/**
 * State for tracking dynamic nodes scheduled via `ctx.runNode()`.
 *
 * Ported (Phase 4 subset) from `google/adk-python`
 * `workflow/_dynamic_node_scheduler.py::DynamicNodeState`. Replay/rehydration
 * fields are added in Phase 5.
 */
export class DynamicNodeState {
  /** Dynamic node runs keyed by unique node path (e.g. `wf/node_a@1`). */
  readonly runs = new Map<string, DynamicNodeRun>();

  /** Union of unresolved interrupt ids across dynamic child nodes. */
  readonly interruptIds = new Set<string>();

  /** All in-flight dynamic node tasks. */
  getDynamicTasks(): Array<Promise<NodeContext>> {
    return [...this.runs.values()]
      .map((run) => run.task)
      .filter((task): task is Promise<NodeContext> => task !== undefined);
  }
}
