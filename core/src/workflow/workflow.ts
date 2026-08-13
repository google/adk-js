/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, trace} from '@opentelemetry/api';
import {Event} from '../events/event.js';
import {tracer, traceWorkflowInvocation} from '../telemetry/tracing.js';
import {experimental} from '../utils/experimental.js';
import {BaseNode, BaseNodeConfig} from './base_node.js';
import {commonPrefixOf} from './branch_path.js';
import {DynamicNodeScheduler} from './dynamic_node_scheduler.js';
import {isInvocationAbortedError} from './errors.js';
import {
  createGraphFromEdgeItems,
  EdgeItem,
  Graph,
  RouteValue,
} from './graph.js';
import {NodeContext, NodeResult} from './node_context.js';
import {
  claimNodeErrorReport,
  createNodeErrorEvent,
} from './node_error_event.js';
import {executeChildNode} from './node_runner.js';
import {createNodeState, NodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {DynamicNodeState} from './schedule_dynamic_node.js';
import {Trigger} from './trigger.js';
import {
  eventsForCurrentRun,
  isFastForwardable,
  makeFastForwardResult,
  reconstructNodeStates,
  RehydratedNode,
  resolvedInterruptResponses,
} from './utils/rehydration_utils.js';

/**
 * A unique symbol branding {@link Workflow} instances.
 *
 * `isWorkflow` matches on this brand rather than `instanceof` so a workflow
 * built by another copy of adk-js in the same runtime is still recognised —
 * mirroring the `Symbol.for('google.adk.*')` brands used across ADK.
 */
const WORKFLOW_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.workflow');

/**
 * An imperative workflow entry point. Receives the workflow's node context and
 * input, drives execution via `ctx.runNode(...)`, and returns the workflow
 * output. Mutually exclusive with `edges`.
 */
export type DynamicEntry = (
  ctx: NodeContext,
  input: unknown,
) => unknown | Promise<unknown>;

/**
 * Configuration for a {@link Workflow}.
 *
 * A workflow is driven either by a static `edges` graph or by an imperative
 * `dynamicEntry` function — exactly one is required, and the two are mutually
 * exclusive. The type is a discriminated union so that constraint is enforced at
 * compile time (the runtime constructor keeps the equivalent throws for JS
 * callers).
 */
export type WorkflowConfig = BaseNodeConfig & {
  /**
   * Maximum number of graph-scheduled nodes running in parallel. `undefined`
   * means unlimited; must be a positive integer otherwise. Does not throttle
   * dynamic (`ctx.runNode`) children.
   */
  maxConcurrency?: number;
} & (
    | {
        /** Edge definitions used to build the workflow graph. */
        edges: EdgeItem[];
        dynamicEntry?: never;
      }
    | {
        /**
         * An imperative entry function driving execution via `ctx.runNode(...)`.
         * Mutually exclusive with `edges`.
         */
        dynamicEntry: DynamicEntry;
        edges?: never;
      }
  );

/**
 * Mutable, in-memory state for a single {@link Workflow} run. Not persisted;
 * discarded when `runImpl` returns. (Replay/checkpoint fields are added in
 * Phase 5.)
 */
class LoopState {
  readonly nodes = new Map<string, NodeState>();
  readonly nodeOutputs = new Map<string, unknown>();
  readonly nodeBranches = new Map<string, string>();
  readonly triggerBuffer = new Map<string, Trigger[]>();
  readonly pending = new Map<string, Promise<CompletedTask>>();
  readonly interruptIds = new Set<string>();
  /** Per-node state reconstructed from prior session events (resume). */
  rehydrated: Map<string, RehydratedNode> = new Map();
  errorShutDown = false;
  /**
   * Workflow-scoped abort signal handed to each scheduled node so a failure can
   * cancel its in-flight siblings (see {@link Workflow.cleanupPending}).
   */
  abortSignal?: AbortSignal;
}

interface CompletedTask {
  name: string;
  /**
   * The finished node's result: a live {@link NodeContext} for a node that ran,
   * or a bare {@link NodeResult} for one fast-forwarded from cached output on
   * resume. Completion handling reads only the shared fields.
   */
  childCtx?: NodeContext | NodeResult;
  error?: unknown;
}

/**
 * A graph-based workflow node. `runImpl()` IS the orchestration loop:
 * SETUP (seed START triggers) → LOOP (schedule ready nodes, handle
 * completions) → FINALIZE (collect the terminal output).
 *
 * Ported (Phase 2 subset) from `google/adk-python` `workflow/_workflow.py`.
 * Replay/checkpointing, dynamic scheduling, and task/chat isolation scopes are
 * added in later phases; hook points are marked with TODO(phase-N).
 */
@experimental
export class Workflow extends BaseNode {
  /** Brand identifying this object as a {@link Workflow} (see `isWorkflow`). */
  readonly [WORKFLOW_SIGNATURE_SYMBOL] = true;

  readonly graph?: Graph;
  readonly dynamicEntry?: DynamicEntry;
  readonly maxConcurrency?: number;

  constructor(config: WorkflowConfig) {
    super({...config, rerunOnResume: config.rerunOnResume ?? true});
    const hasEdges = !!config.edges && config.edges.length > 0;
    if (hasEdges && config.dynamicEntry) {
      throw new Error(
        `Workflow "${this.name}": "edges" and "dynamicEntry" are mutually exclusive.`,
      );
    }
    if (!hasEdges && !config.dynamicEntry) {
      throw new Error(
        `Workflow "${this.name}" requires either "edges" or "dynamicEntry".`,
      );
    }
    if (
      config.maxConcurrency !== undefined &&
      (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1)
    ) {
      throw new Error(
        `Workflow "${this.name}": "maxConcurrency" must be a positive integer ` +
          `(got ${config.maxConcurrency}).`,
      );
    }
    this.maxConcurrency = config.maxConcurrency;
    this.dynamicEntry = config.dynamicEntry;
    if (config.edges && config.edges.length > 0) {
      // createGraphFromEdgeItems validates as part of construction.
      this.graph = createGraphFromEdgeItems(config.edges);
    }
  }

  // eslint-disable-next-line require-yield -- child events stream out via ctx.channel/ctx.runNode; this orchestration generator itself yields nothing
  protected async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Child events are streamed through ctx.channel by ctx.runNode(), so this
    // orchestration generator itself yields nothing.
    const dynamicState = new DynamicNodeState();

    // Workflow-scoped cancellation: a controller chained to the invocation's
    // abort signal. It is aborted when a node fails (see cleanupPending) so any
    // in-flight siblings stop cooperatively instead of running to completion,
    // and disposed in the finally so we don't leak the parent-abort listener.
    const abort = createWorkflowAbort(ctx.invocationContext.abortSignal);
    ctx.scheduler = new DynamicNodeScheduler(
      dynamicState,
      abort.controller.signal,
    );

    const span = tracer.startSpan(`invoke_workflow ${this.name}`);
    try {
      // Sync callback returning the promise, not `async () => await …`: the
      // wrapper must not insert microtask hops around the orchestration loop
      // (see the note in `executeChildNode`).
      await context.with(trace.setSpan(context.active(), span), () => {
        traceWorkflowInvocation({
          workflowName: this.name,
          nodePath: ctx.nodePath,
        });
        return this.orchestrate(ctx, nodeInput, dynamicState, abort.controller);
      });
    } finally {
      abort.dispose();
      span.end();
    }
  }

  /**
   * The orchestration body, wrapped by {@link runImpl} so its workflow-scoped
   * abort controller is always disposed.
   */
  private async orchestrate(
    ctx: NodeContext,
    nodeInput: unknown,
    dynamicState: DynamicNodeState,
    abortController: AbortController,
  ): Promise<void> {
    // --- REHYDRATE (resume) ---
    // Reconstruct node state from prior session events and surface resolved
    // interrupt responses so waiting nodes can resume. Scope to the run still
    // in progress (so a run that already completed is not replayed), and to
    // this workflow's own direct children (by path) so nested workflows with
    // same-named nodes don't collide.
    const runEvents = eventsForCurrentRun(
      ctx.session?.events ?? [],
      ctx.invocationId,
    );
    const rehydrated = reconstructNodeStates(
      runEvents,
      ctx.nodePath || undefined,
    );
    this.applyResumeInputs(ctx, runEvents);

    if (this.dynamicEntry) {
      await this.runDynamicEntry(ctx, nodeInput, dynamicState);
      return;
    }

    const loop = new LoopState();
    loop.rehydrated = rehydrated;
    loop.abortSignal = abortController.signal;

    this.seedStartTriggers(loop, nodeInput);

    await this.runLoop(loop, ctx, abortController);

    if (loop.errorShutDown) {
      return;
    }

    this.collectRemainingInterrupts(loop);
    // Fold in interrupts raised by dynamic (ctx.runNode) children.
    for (const id of dynamicState.interruptIds) {
      loop.interruptIds.add(id);
    }

    this.finalize(loop, ctx);
  }

  /**
   * Runs an imperative `dynamicEntry` workflow. The entry drives execution via
   * `ctx.runNode(...)` (routed through the scheduler) and returns the output.
   */
  private async runDynamicEntry(
    ctx: NodeContext,
    nodeInput: unknown,
    dynamicState: DynamicNodeState,
  ): Promise<void> {
    const output = await this.dynamicEntry!(ctx, nodeInput);
    if (dynamicState.interruptIds.size > 0) {
      ctx.interruptIds = [...dynamicState.interruptIds];
      return;
    }
    if (output !== undefined) {
      ctx.output = output;
    }
  }

  /**
   * Merges resolved interrupt responses from prior session events into
   * `ctx.resumeInputs`, so waiting nodes (which read `ctx.resumeInputs[id]`)
   * resume with the user's response. Shared by child contexts via propagation.
   *
   * Taken from the events rather than from `rehydrated`, because that view is
   * scoped to this workflow's direct children: an interrupt raised deeper — by
   * a `ctx.runNode` child, or inside a nested workflow — is keyed out of it,
   * and its answer would never reach the node waiting on it.
   */
  private applyResumeInputs(ctx: NodeContext, runEvents: Event[]): void {
    for (const [interruptId, response] of resolvedInterruptResponses(
      runEvents,
    )) {
      ctx.resumeInputs[interruptId] = response;
    }
  }

  // --- SETUP ---

  private seedStartTriggers(loop: LoopState, nodeInput: unknown): void {
    const startEdges = this.graph!.edges.filter(
      (e) => e.fromNode.name === '__START__',
    );
    const useSubBranch = startEdges.length > 1;
    for (const edge of startEdges) {
      this.pushTrigger(loop, edge.toNode.name, {
        input: nodeInput,
        useSubBranch,
      });
    }
  }

  // --- LOOP ---

  private async runLoop(
    loop: LoopState,
    ctx: NodeContext,
    abortController: AbortController,
  ): Promise<void> {
    for (;;) {
      this.scheduleReadyNodes(loop, ctx);

      if (loop.pending.size === 0) {
        break;
      }

      const result = await Promise.race(loop.pending.values());
      loop.pending.delete(result.name);

      if (result.error) {
        const nodeState = loop.nodes.get(result.name);
        if (nodeState) {
          nodeState.status = NodeStatus.FAILED;
        }
        this.reportNodeError(loop, ctx, result.name, result.error);
        loop.errorShutDown = true;
        await this.cleanupPending(loop, abortController);
        throw result.error;
      }

      await this.handleCompletion(loop, result.name, result.childCtx!);
    }
  }

  private reportNodeError(
    loop: LoopState,
    ctx: NodeContext,
    nodeName: string,
    error: unknown,
  ): void {
    if (isInvocationAbortedError(error) || loop.abortSignal?.aborted) {
      return;
    }
    if (!claimNodeErrorReport(error, ctx.invocationId)) {
      return;
    }
    ctx.emit(
      createNodeErrorEvent({
        error,
        attemptCount: loop.nodes.get(nodeName)?.attemptCount ?? 1,
        author: nodeName,
        invocationId: ctx.invocationId,
        nodeInfo: {
          path: ctx.nodePath ? `${ctx.nodePath}.${nodeName}` : nodeName,
        },
        branch: ctx.branch,
        isolationScope: ctx.isolationScope,
      }),
    );
  }

  // --- Scheduling ---

  private scheduleReadyNodes(loop: LoopState, ctx: NodeContext): void {
    for (const nodeName of [...loop.triggerBuffer.keys()]) {
      if (loop.pending.has(nodeName)) {
        continue;
      }
      const state = loop.nodes.get(nodeName);
      if (state) {
        if (state.status === NodeStatus.RUNNING) {
          continue;
        }
        if (
          state.status === NodeStatus.WAITING &&
          state.interrupts.length > 0
        ) {
          continue;
        }
      }
      if (this.atConcurrencyLimit(loop)) {
        break;
      }

      const trigger = this.popTrigger(loop, nodeName);
      if (!trigger) {
        continue;
      }
      this.prepareNodeStateForStarting(loop, nodeName, trigger);
      this.startNodeTask(loop, ctx, nodeName, trigger);
    }
  }

  private atConcurrencyLimit(loop: LoopState): boolean {
    return (
      this.maxConcurrency !== undefined &&
      loop.pending.size >= this.maxConcurrency
    );
  }

  private prepareNodeStateForStarting(
    loop: LoopState,
    nodeName: string,
    trigger: Trigger,
  ): void {
    const existing = loop.nodes.get(nodeName);
    // Fresh NodeState for each run, preserving the run counter.
    const state = createNodeState({
      runCounter: existing?.runCounter ?? 0,
    });
    state.input = trigger.input;
    state.status = NodeStatus.RUNNING;
    loop.nodes.set(nodeName, state);
  }

  private startNodeTask(
    loop: LoopState,
    ctx: NodeContext,
    nodeName: string,
    trigger: Trigger,
  ): void {
    const node = this.getStaticNode(nodeName);
    const nodeState = loop.nodes.get(nodeName)!;

    // Resume: fast-forward a node that already completed in a prior run
    // (cached output, all interrupts resolved), unless it must rerun on resume.
    const prior = loop.rehydrated.get(nodeName);
    if (prior && !node.rerunOnResume && isFastForwardable(prior)) {
      loop.pending.set(
        nodeName,
        Promise.resolve({
          name: nodeName,
          childCtx: makeFastForwardResult(ctx, prior),
        }),
      );
      return;
    }

    // Resume with rerun_on_resume=false: a node that interrupted last turn
    // (raised interrupts, produced no output) does NOT re-run its body. Instead
    // it completes with the resolved resume value(s) as its output, feeding the
    // next node. This is Python's two-node request-input pattern, where one node
    // yields RequestInput and its successor receives the human's reply as input.
    if (
      prior &&
      !node.rerunOnResume &&
      prior.output === undefined &&
      prior.interruptIds.size > 0
    ) {
      const values = [...prior.interruptIds].map((id) => ctx.resumeInputs[id]);
      if (values.every((v) => v !== undefined)) {
        const output = values.length === 1 ? values[0] : values;
        const resumeResult: NodeResult = {
          output,
          route: undefined,
          branch: prior.branch ?? ctx.branch,
          interruptIds: [],
        };
        loop.pending.set(
          nodeName,
          Promise.resolve({name: nodeName, childCtx: resumeResult}),
        );
        return;
      }
    }

    let runId = nodeState.runId;
    if (!runId) {
      nodeState.runCounter += 1;
      runId = String(nodeState.runCounter);
      nodeState.runId = runId;
    }

    // On resume, a waiting node (it interrupted last turn) re-runs with its
    // ORIGINAL input, not the trigger's (which carries the resume message).
    const resuming =
      prior !== undefined &&
      prior.interruptIds.size > 0 &&
      prior.input !== undefined;
    const nodeInput = resuming ? prior.input : trigger.input;

    // Static graph nodes are managed by this loop directly, bypassing the
    // dynamic scheduler (which serves user-initiated ctx.runNode() calls). The
    // workflow-scoped abort signal lets a sibling's failure cancel this node.
    const task: Promise<CompletedTask> = executeChildNode({
      parent: ctx,
      node,
      input: nodeInput,
      abortSignal: loop.abortSignal,
      nodeState,
      options: {
        runId,
        useSubBranch: trigger.useSubBranch,
        overrideBranch: trigger.branch,
        overrideIsolationScope: trigger.isolationScope,
      },
    }).then(
      (childCtx) => ({name: nodeName, childCtx}),
      (error) => ({name: nodeName, error}),
    );
    loop.pending.set(nodeName, task);
  }

  // --- Completion handling ---

  private async handleCompletion(
    loop: LoopState,
    nodeName: string,
    childCtx: NodeContext | NodeResult,
  ): Promise<void> {
    const nodeState = loop.nodes.get(nodeName)!;
    const node = this.getStaticNode(nodeName);

    if (childCtx.interruptIds.length > 0) {
      nodeState.status = NodeStatus.WAITING;
      nodeState.interrupts = [...childCtx.interruptIds];
      childCtx.interruptIds.forEach((id) => loop.interruptIds.add(id));
      return;
    }

    if (
      node.waitForOutput &&
      childCtx.output === undefined &&
      childCtx.route === undefined
    ) {
      nodeState.status = NodeStatus.WAITING;
      return;
    }

    nodeState.status = NodeStatus.COMPLETED;
    if (childCtx.output !== undefined) {
      loop.nodeOutputs.set(nodeName, childCtx.output);
    }
    loop.nodeBranches.set(nodeName, childCtx.branch ?? '');

    this.bufferDownstreamTriggers(
      loop,
      nodeName,
      childCtx.output,
      childCtx.route,
      childCtx.branch,
    );
  }

  private bufferDownstreamTriggers(
    loop: LoopState,
    nodeName: string,
    output: unknown,
    route: RouteValue | RouteValue[] | undefined,
    branch: string | undefined,
  ): void {
    const nextNodes = this.graph!.getNextPendingNodes(nodeName, route ?? null);
    const useSubBranch = nextNodes.length > 1;

    for (const targetName of nextNodes) {
      const targetNode = this.getStaticNode(targetName);

      if (targetNode.requiresAllPredecessors) {
        const predecessors = new Set(
          this.graph!.edges.filter((e) => e.toNode.name === targetName).map(
            (e) => e.fromNode.name,
          ),
        );
        const allCompleted = [...predecessors].every(
          (p) => loop.nodes.get(p)?.status === NodeStatus.COMPLETED,
        );
        if (allCompleted) {
          const outputs: Record<string, unknown> = {};
          for (const p of predecessors) {
            outputs[p] = loop.nodeOutputs.get(p);
          }
          const branches = [...predecessors].map(
            (p) => loop.nodeBranches.get(p) ?? '',
          );
          const commonBranch = commonPrefixOf(branches);
          this.pushTrigger(loop, targetName, {
            input: outputs,
            useSubBranch: false,
            branch: commonBranch || undefined,
          });
        }
      } else {
        this.pushTrigger(loop, targetName, {
          input: output,
          useSubBranch,
          branch,
        });
      }
    }
  }

  private collectRemainingInterrupts(loop: LoopState): void {
    for (const nodeState of loop.nodes.values()) {
      if (
        nodeState.status === NodeStatus.WAITING &&
        nodeState.interrupts.length > 0
      ) {
        nodeState.interrupts.forEach((id) => loop.interruptIds.add(id));
      }
    }
  }

  // --- FINALIZE ---

  private finalize(loop: LoopState, ctx: NodeContext): void {
    if (loop.interruptIds.size > 0) {
      ctx.interruptIds = [...loop.interruptIds];
      return;
    }

    const terminalOutputs = [...this.graph!.terminalNodeNames]
      .filter((name) => loop.nodeOutputs.has(name))
      .map((name) => loop.nodeOutputs.get(name));

    if (terminalOutputs.length === 1) {
      ctx.output = terminalOutputs[0];
    } else if (terminalOutputs.length > 1) {
      throw new Error(
        `Workflow ${this.name}: multiple terminal nodes produced output ` +
          `(${terminalOutputs.length}). A workflow must have at most one terminal output.`,
      );
    }
  }

  // --- Utilities ---

  private pushTrigger(
    loop: LoopState,
    nodeName: string,
    trigger: Trigger,
  ): void {
    const buffer = loop.triggerBuffer.get(nodeName);
    if (buffer) {
      buffer.push(trigger);
    } else {
      loop.triggerBuffer.set(nodeName, [trigger]);
    }
  }

  private popTrigger(loop: LoopState, nodeName: string): Trigger | undefined {
    const buffer = loop.triggerBuffer.get(nodeName);
    if (!buffer || buffer.length === 0) {
      return undefined;
    }
    const trigger = buffer.shift()!;
    if (buffer.length === 0) {
      loop.triggerBuffer.delete(nodeName);
    }
    return trigger;
  }

  private getStaticNode(name: string): BaseNode {
    const node = this.graph!.nodes.find((n) => n.name === name);
    if (!node) {
      throw new Error(`Node ${name} not found in graph.`);
    }
    return node;
  }

  private async cleanupPending(
    loop: LoopState,
    abortController: AbortController,
  ): Promise<void> {
    // Signal in-flight siblings to stop: cooperative nodes observe
    // `ctx.abortSignal`, and the node runner stops consuming their events once
    // the signal fires (see node_runner). Then await the outstanding tasks so
    // their cleanup runs and events flush; failures are swallowed because the
    // workflow is already shutting down on error.
    abortController.abort();
    const outstanding = [...loop.pending.values()];
    loop.pending.clear();
    await Promise.allSettled(outstanding);
  }
}

/**
 * Type guard for {@link Workflow}.
 *
 * Matches on the `google.adk.workflow.workflow` brand rather than `instanceof`
 * so it stays correct across package copies — two copies of adk-js in one
 * runtime would fail an `instanceof` check between them. Named rather than
 * `{@link}`ed because the brand itself is internal, and this guard is public.
 */
export function isWorkflow(value: unknown): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    WORKFLOW_SIGNATURE_SYMBOL in value &&
    value[WORKFLOW_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Creates the workflow-scoped {@link AbortController} that cancels in-flight
 * nodes when the workflow shuts down on error. It is chained to the invocation's
 * own abort signal (if any) so an invocation-level cancel still propagates to
 * nodes; `dispose` detaches that listener to avoid a leak.
 */
function createWorkflowAbort(parentSignal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!parentSignal) {
    return {controller, dispose: () => {}};
  }
  if (parentSignal.aborted) {
    controller.abort();
    return {controller, dispose: () => {}};
  }
  const onParentAbort = () => controller.abort();
  parentSignal.addEventListener('abort', onParentAbort, {once: true});
  return {
    controller,
    dispose: () => parentSignal.removeEventListener('abort', onParentAbort),
  };
}
