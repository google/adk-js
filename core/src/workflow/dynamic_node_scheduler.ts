/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode} from './base_node.js';
import {NodeContext, NodeResult} from './node_context.js';
import {executeChildNode} from './node_runner.js';
import {createNodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {
  DynamicNodeRun,
  DynamicNodeState,
  ScheduleDynamicNode,
  ScheduleDynamicNodeOptions,
} from './schedule_dynamic_node.js';
import {
  isFastForwardable,
  makeFastForwardResult,
  reconstructNodeStatesByPath,
} from './utils/rehydration_utils.js';

/**
 * Handles `ctx.runNode()` calls for a {@link Workflow} subtree.
 *
 * Ported (Phase 4 subset) from `google/adk-python`
 * `workflow/_dynamic_node_scheduler.py`. Implemented now: fresh execution and
 * deduplication of concurrent calls to the same node path. Resumption from
 * session events (rehydration + replay interception) is added in Phase 5 at the
 * marked hook point.
 */
export class DynamicNodeScheduler implements ScheduleDynamicNode {
  /**
   * @param state Shared dynamic-node bookkeeping for this workflow subtree.
   * @param abortSignal Workflow-scoped cancellation signal, forwarded to each
   *   dynamic child so a workflow shutting down on error can cancel in-flight
   *   `ctx.runNode()` children too.
   */
  constructor(
    private readonly state: DynamicNodeState,
    private readonly abortSignal?: AbortSignal,
  ) {}

  async schedule(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    const name = options.nodeName ?? node.name;
    const runId = options.runId;
    const nodePath = ctx.nodePath
      ? `${ctx.nodePath}.${name}@${runId}`
      : `${name}@${runId}`;

    const existing = this.state.runs.get(nodePath);
    if (existing?.task) {
      // Deduplicate concurrent calls: await the in-flight task.
      return existing.task;
    }

    // Cross-turn resume: rehydrate this dynamic run from prior session events.
    if (!this.state.runs.has(nodePath)) {
      const prior = reconstructNodeStatesByPath(ctx.session?.events ?? []).get(
        nodePath,
      );
      if (prior && !node.rerunOnResume && isFastForwardable(prior)) {
        // Completed in a prior turn -> return cached output, do not re-execute.
        this.state.runs.set(nodePath, {
          state: createNodeState({
            status: NodeStatus.COMPLETED,
            runId,
            parentRunId: ctx.runId,
          }),
          output: prior.output,
        });
        if (options.useAsOutput) {
          ctx.output = prior.output;
          ctx.route = prior.route;
        }
        return makeFastForwardResult(ctx, prior);
      }
      // Otherwise (waiting/unresolved): resume inputs were already merged into
      // ctx.resumeInputs by the Workflow; fall through to a fresh run.
    }

    return this.runFresh(ctx, node, input, name, runId, nodePath, options);
  }

  private async runFresh(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    name: string,
    runId: string,
    nodePath: string,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext> {
    const run: DynamicNodeRun = {
      state: createNodeState({
        status: NodeStatus.RUNNING,
        input,
        runId,
        parentRunId: ctx.runId,
      }),
    };
    this.state.runs.set(nodePath, run);

    run.task = executeChildNode({
      parent: ctx,
      node,
      input,
      abortSignal: this.abortSignal,
      options: {
        nodeName: name,
        runId,
        overrideNodePath: nodePath,
        useAsOutput: options.useAsOutput,
        useSubBranch: options.useSubBranch,
        overrideBranch: options.overrideBranch,
        overrideIsolationScope: options.overrideIsolationScope,
      },
    });

    const childCtx = await run.task;
    this.recordResult(run, childCtx, node);
    return childCtx;
  }

  private recordResult(
    run: DynamicNodeRun,
    childCtx: NodeContext,
    node: BaseNode,
  ): void {
    if (childCtx.interruptIds.length > 0) {
      run.state.status = NodeStatus.WAITING;
      run.state.interrupts = [...childCtx.interruptIds];
      childCtx.interruptIds.forEach((id) => this.state.interruptIds.add(id));
    } else if (
      node.waitForOutput &&
      childCtx.output === undefined &&
      childCtx.route === undefined
    ) {
      run.state.status = NodeStatus.WAITING;
    } else {
      run.state.status = NodeStatus.COMPLETED;
      run.output = childCtx.output;
    }
  }
}
