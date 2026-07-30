/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';

import {BaseNode, BaseNodeConfig, START} from './base_node.js';
import {Edge, EdgeItem, Graph} from './graph.js';
import {NodeContext} from './node_context.js';
import {runNode} from './node_runner.js';

/**
 * The parameters for creating a {@link Workflow}.
 */
export interface WorkflowConfig extends BaseNodeConfig {
  /** The graph to run, as explicit edges and/or chains. */
  edges: readonly EdgeItem[];

  /**
   * Maximum number of node runs before the workflow gives up. Unbounded by
   * default, mirroring `LoopAgent.maxIterations`; set it when the graph has a
   * routed cycle that could keep looping.
   */
  maxSteps?: number;
}

/** The inputs queued for a node that is waiting to run. */
interface PendingRuns {
  node: BaseNode;
  inputs: unknown[];
}

/**
 * The mutable state of one workflow run.
 *
 * Every collection is keyed by node name, so all of them are bounded by the
 * size of the graph however long a routed cycle keeps running. Keep it that
 * way: do not accumulate per-run history here.
 */
interface RunState {
  /** Nodes with queued inputs, in the order their first input arrived. */
  pending: Map<string, PendingRuns>;

  /** Nodes that have finished a run without staying pending for output. */
  completed: Set<string>;

  /** The latest output of each node that produced one. */
  outputs: Map<string, unknown>;

  /** How many times each node has run, which gives each run its id. */
  runCounts: Map<string, number>;
}

/**
 * Queues an input for a node, keeping the node's place in the run order.
 */
function enqueue(state: RunState, node: BaseNode, input: unknown): void {
  const existing = state.pending.get(node.name);
  if (existing) {
    existing.inputs.push(input);
    return;
  }
  state.pending.set(node.name, {node, inputs: [input]});
}

/** The names of the nodes with an edge into `targetName`. */
function predecessorNames(
  edges: readonly Edge[],
  targetName: string,
): string[] {
  const names = new Set<string>();
  for (const edge of edges) {
    if (edge.toNode.name === targetName) {
      names.add(edge.fromNode.name);
    }
  }
  return [...names];
}

/**
 * A node that runs a graph of other nodes.
 *
 * The graph is built and validated eagerly, so a malformed one throws at
 * construction. Nodes run one at a time, in the order their inputs arrived.
 * Because a workflow is itself a node, it can appear in another workflow's
 * edges and gets that node's retry and timeout handling.
 *
 * ```ts
 * const wf = new Workflow({
 *   name: 'triage',
 *   edges: [
 *     [START, classify],
 *     {fromNode: classify, toNode: handleHigh, route: 'high'},
 *     {fromNode: classify, toNode: handleLow, route: DEFAULT_ROUTE},
 *   ],
 * });
 * ```
 */
@experimental
export class Workflow extends BaseNode<WorkflowConfig> {
  /** The validated graph this workflow runs. */
  readonly graph: Graph;

  /** See {@link WorkflowConfig.maxSteps}. */
  readonly maxSteps: number;

  constructor(config: WorkflowConfig) {
    super(config);
    this.maxSteps = config.maxSteps ?? Number.MAX_SAFE_INTEGER;
    this.graph = Graph.fromEdgeItems(config.edges);
    this.graph.validate();
  }

  override async *run(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    const state: RunState = {
      pending: new Map(),
      completed: new Set(),
      outputs: new Map(),
      runCounts: new Map(),
    };

    for (const edge of this.graph.edges) {
      if (edge.fromNode.name === START.name) {
        enqueue(state, edge.toNode, nodeInput);
      }
    }

    let steps = 0;
    for (;;) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const next = state.pending.entries().next();
      if (next.done) {
        break;
      }
      const [nodeName, runs] = next.value;
      const input = runs.inputs.shift();
      if (runs.inputs.length === 0) {
        state.pending.delete(nodeName);
      }

      if (++steps > this.maxSteps) {
        throw new Error(
          `Workflow ${this.name}: exceeded maxSteps (${this.maxSteps}).`,
        );
      }

      const runCount = (state.runCounts.get(nodeName) ?? 0) + 1;
      state.runCounts.set(nodeName, runCount);
      const childCtx = yield* runNode(runs.node, {
        invocationContext: ctx.invocationContext,
        nodeInput: input,
        parentNodePath: ctx.nodePath,
        runId: String(runCount),
      });

      if (
        runs.node.waitForOutput &&
        childCtx.output === undefined &&
        childCtx.route === undefined
      ) {
        // The node is a barrier that has not opened yet: leave it incomplete
        // so its predecessors can trigger it again.
        continue;
      }

      state.completed.add(nodeName);
      if (childCtx.output !== undefined) {
        state.outputs.set(nodeName, childCtx.output);
      }
      this.triggerDownstream(state, nodeName, childCtx.output, childCtx.route);
    }

    const terminalOutputs = [...this.graph.terminalNodeNames]
      .filter((name) => state.outputs.has(name))
      .map((name) => state.outputs.get(name));
    if (terminalOutputs.length > 1) {
      throw new Error(
        `Workflow ${this.name}: multiple terminal nodes produced output ` +
          `(${terminalOutputs.length}). A workflow must have at most one ` +
          'terminal output.',
      );
    }
    if (terminalOutputs.length === 1) {
      ctx.output = terminalOutputs[0];
    }
  }

  /** Queues the nodes reached by the edges the completed node opened. */
  private triggerDownstream(
    state: RunState,
    nodeName: string,
    output: unknown,
    route: NodeContext['route'],
  ): void {
    for (const target of this.graph.getNextPendingNodes(nodeName, route)) {
      if (!target.requiresAllPredecessors) {
        enqueue(state, target, output);
        continue;
      }
      const predecessors = predecessorNames(this.graph.edges, target.name);
      if (!predecessors.every((name) => state.completed.has(name))) {
        continue;
      }
      const aggregated: Record<string, unknown> = {};
      for (const name of predecessors) {
        aggregated[name] = state.outputs.get(name);
      }
      enqueue(state, target, aggregated);
    }
  }
}
