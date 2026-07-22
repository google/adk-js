/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {BaseNode, BaseNodeConfig} from './base_node.js';
import {BranchPath} from './branch_path.js';
import {DynamicNodeScheduler} from './dynamic_node_scheduler.js';
import {EdgeItem, Graph, RouteValue} from './graph.js';
import {NodeContext} from './node_context.js';
import {executeChildNode} from './node_runner.js';
import {createNodeState, NodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {DynamicNodeState} from './schedule_dynamic_node.js';
import {Trigger} from './trigger.js';

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
 */
export interface WorkflowConfig extends BaseNodeConfig {
  /** Edge definitions used to build the workflow graph. */
  edges?: EdgeItem[];
  /**
   * An imperative entry function driving execution via `ctx.runNode(...)`.
   * Mutually exclusive with {@link edges}.
   */
  dynamicEntry?: DynamicEntry;
  /**
   * Maximum number of graph-scheduled nodes running in parallel. `undefined`
   * means unlimited. Does not throttle dynamic (`ctx.runNode`) children.
   */
  maxConcurrency?: number;
}

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
  errorShutDown = false;
}

interface CompletedTask {
  name: string;
  childCtx?: NodeContext;
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
export class Workflow extends BaseNode {
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
    this.maxConcurrency = config.maxConcurrency;
    this.dynamicEntry = config.dynamicEntry;
    if (hasEdges) {
      this.graph = Graph.fromEdgeItems(config.edges!);
      this.graph.validate();
    }
  }

  // eslint-disable-next-line require-yield
  protected async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    // Child events are streamed through ctx.channel by ctx.runNode(), so this
    // orchestration generator itself yields nothing.
    const dynamicState = new DynamicNodeState();
    ctx.scheduler = new DynamicNodeScheduler(dynamicState);

    if (this.dynamicEntry) {
      await this.runDynamicEntry(ctx, nodeInput, dynamicState);
      return;
    }

    const loop = new LoopState();

    // --- SETUP ---
    this.seedStartTriggers(loop, nodeInput);

    // --- LOOP ---
    await this.runLoop(loop, ctx);

    if (loop.errorShutDown) {
      return;
    }

    this.collectRemainingInterrupts(loop);
    // Fold in interrupts raised by dynamic (ctx.runNode) children.
    for (const id of dynamicState.interruptIds) {
      loop.interruptIds.add(id);
    }

    // --- FINALIZE ---
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

  private async runLoop(loop: LoopState, ctx: NodeContext): Promise<void> {
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
        loop.errorShutDown = true;
        await this.cleanupPending(loop);
        throw result.error;
      }

      await this.handleCompletion(loop, result.name, result.childCtx!);
    }
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
    return !!this.maxConcurrency && loop.pending.size >= this.maxConcurrency;
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

    let runId = nodeState.runId;
    if (!runId) {
      nodeState.runCounter += 1;
      runId = String(nodeState.runCounter);
      nodeState.runId = runId;
    }

    // Static graph nodes are managed by this loop directly, bypassing the
    // dynamic scheduler (which serves user-initiated ctx.runNode() calls).
    const task: Promise<CompletedTask> = executeChildNode(
      ctx,
      node,
      trigger.input,
      {
        runId,
        useSubBranch: trigger.useSubBranch,
        overrideBranch: trigger.branch,
        overrideIsolationScope: trigger.isolationScope,
      },
    ).then(
      (childCtx) => ({name: nodeName, childCtx}),
      (error) => ({name: nodeName, error}),
    );
    loop.pending.set(nodeName, task);
  }

  // --- Completion handling ---

  private async handleCompletion(
    loop: LoopState,
    nodeName: string,
    childCtx: NodeContext,
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
    route: RouteValue | undefined,
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
          const commonBranch = BranchPath.commonPrefixOf(branches);
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

  private async cleanupPending(loop: LoopState): Promise<void> {
    // Await outstanding tasks so their events flush; failures are swallowed
    // because the workflow is already shutting down on error.
    const outstanding = [...loop.pending.values()];
    loop.pending.clear();
    await Promise.allSettled(outstanding);
  }
}
