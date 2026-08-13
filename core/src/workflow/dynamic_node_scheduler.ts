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
  eventsForCurrentRun,
  isFastForwardable,
  makeFastForwardResult,
  reconstructNodeStatesByPath,
  type RehydratedNode,
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

    // Cross-turn resume: rehydrate this dynamic run from the events of the run
    // still in progress (a run that already completed must not be replayed).
    if (!this.state.runs.has(nodePath)) {
      const prior = reconstructNodeStatesByPath(
        eventsForCurrentRun(ctx.session?.events ?? [], ctx.invocationId),
      ).get(nodePath);
      if (prior && isFastForwardable(prior)) {
        // Completed in a prior turn -> return cached output, do not re-execute.
        // `rerunOnResume` is deliberately not consulted, as in the static twin
        // (`Workflow.scheduleNode`): it says what to do with an interrupt the
        // node is still waiting on, and `isFastForwardable` has already ruled
        // a waiting node out. Consulted here it would replay the whole run.
        return this.completeWithoutRunning(
          ctx,
          {nodePath, runId, options},
          makeFastForwardResult(ctx, prior),
        );
      }
      // Resume with rerunOnResume=false: a child that interrupted last turn
      // (raised interrupts, produced no output) does NOT re-run its body. It
      // completes with the resolved resume value(s) as its output, which
      // `ctx.runNode()` hands back to the caller. Mirrors the static-graph
      // handoff in `Workflow.scheduleNode`; without it such a child re-runs,
      // raises a brand-new interrupt, and the workflow can never resume.
      const handoff = this.resumeHandoff(ctx, node, prior);
      if (handoff) {
        return this.completeWithoutRunning(
          ctx,
          {nodePath, runId, options},
          handoff,
        );
      }
      // Otherwise (waiting/unresolved): resume inputs were already merged into
      // ctx.resumeInputs by the Workflow; fall through to a fresh run.
    }

    return this.runFresh(ctx, node, input, name, runId, nodePath, options);
  }

  /**
   * Books a dynamic run that completed WITHOUT executing its body — either
   * fast-forwarded from a cached output or handed the resolved resume value —
   * and returns `result` for `ctx.runNode()` to give back to the caller.
   */
  private completeWithoutRunning(
    ctx: NodeContext,
    run: {
      nodePath: string;
      runId: string;
      options: ScheduleDynamicNodeOptions;
    },
    result: NodeResult,
  ): NodeResult {
    this.state.runs.set(run.nodePath, {
      state: createNodeState({
        status: NodeStatus.COMPLETED,
        runId: run.runId,
        parentRunId: ctx.runId,
      }),
      output: result.output,
    });
    if (run.options.useAsOutput) {
      ctx.output = result.output;
      ctx.route = result.route;
    }
    return result;
  }

  /**
   * Builds the completion result for a child that interrupted in a prior turn
   * and whose interrupts are now all resolved, or `undefined` when the child is
   * not in that state (so the caller falls through to a fresh run).
   */
  private resumeHandoff(
    ctx: NodeContext,
    node: BaseNode,
    prior: RehydratedNode | undefined,
  ): NodeResult | undefined {
    if (
      !prior ||
      node.rerunOnResume ||
      prior.output !== undefined ||
      prior.interruptIds.size === 0
    ) {
      return undefined;
    }
    const values = [...prior.interruptIds].map((id) => ctx.resumeInputs[id]);
    if (!values.every((value) => value !== undefined)) {
      return undefined;
    }
    return {
      output: values.length === 1 ? values[0] : values,
      route: undefined,
      branch: prior.branch ?? ctx.branch,
      interruptIds: [],
    };
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
