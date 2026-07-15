/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {BaseNode} from './base_node.js';
import {NodeState, NodeStatus, isNodeState} from './node_state.js';
import {GraphEdge, ParsedGraph, parseGraph} from './utils/graph_parser.js';
import {validateGraph} from './utils/graph_validation.js';
import {runWithRetry} from './utils/retry_utils.js';

/**
 * Options for configuring the NodeRunner.
 */
export interface NodeRunnerOptions {
  /**
   * Whether to allow cycles in the graph during validation.
   * Default is false.
   */
  allowCycles?: boolean;

  /**
   * Key inside `InvocationContext.agentStates` where the final leaf node outputs
   * should also be written or aggregated, if requested by the workflow.
   */
  outputKey?: string;
}

interface QueueItem {
  readonly node: BaseNode;
  readonly inputPayload?: unknown;
  readonly sourceNodeName: string;
}

/**
 * Consumes an AsyncGenerator to completion, capturing all yielded Events via onEvent
 * and extracting the final return value when `done: true`.
 * Also detects if any yielded Event signals a Human-in-the-Loop (`RequestInput`) pause condition.
 */
export async function consumeGenerator<TOutput = unknown>(
  generator: AsyncGenerator<Event, TOutput, unknown>,
  onEvent?: (event: Event) => void | Promise<void>,
): Promise<{
  output: TOutput | undefined;
  isPausedHitl: boolean;
  lastEvent?: Event;
}> {
  let isPausedHitl = false;
  let lastEvent: Event | undefined;

  while (true) {
    const {value, done} = await generator.next();
    if (done) {
      let output = value as TOutput | undefined;
      if (
        output === undefined &&
        lastEvent?.actions &&
        typeof lastEvent.actions === 'object' &&
        'output' in (lastEvent.actions as unknown as Record<string, unknown>)
      ) {
        output = (lastEvent.actions as unknown as Record<string, unknown>)
          .output as TOutput;
      }
      return {output, isPausedHitl, lastEvent};
    }

    const event = value as Event;
    lastEvent = event;
    if (onEvent) {
      await onEvent(event);
    }
    if (isHitlPauseEvent(event)) {
      isPausedHitl = true;
      return {output: undefined, isPausedHitl, lastEvent: event};
    }
  }
}

/**
 * Executes a static graph workflow (`edges`) using topological queue-based scheduling,
 * evaluating edge triggers upon node completion, checkpointing state in `InvocationContext.agentStates`,
 * and handling Human-in-the-Loop (`RequestInput` / `PAUSED_HITL`) interruptions cleanly.
 */
export class NodeRunner {
  readonly graph: ParsedGraph;
  readonly options: NodeRunnerOptions;

  /**
   * @param edgesOrGraph Array of GraphEdge sequences or a pre-parsed ParsedGraph.
   * @param options Optional configuration for the runner.
   */
  constructor(
    edgesOrGraph: GraphEdge[] | ParsedGraph,
    options?: NodeRunnerOptions,
  ) {
    if (edgesOrGraph instanceof ParsedGraph) {
      this.graph = edgesOrGraph;
    } else {
      this.graph = parseGraph(edgesOrGraph);
    }
    this.options = options || {};
    validateGraph(this.graph, {allowCycles: this.options.allowCycles});
  }

  /**
   * Executes the workflow graph from "START" (or from paused/rehydrated checkpoints).
   * @param ctx The invocation context for the workflow run.
   * @param initialInput Optional initial input payload passed to START nodes.
   * @yields All events generated during node execution.
   */
  async *runAsync(
    ctx: InvocationContext,
    initialInput?: unknown,
  ): AsyncGenerator<Event, void, void> {
    const agentStates = getOrInitAgentStates(ctx);
    const queue: QueueItem[] = [];

    // 1. Initialize queue with edges originating from "START"
    const startEdges = this.graph.adjacencyList.get('START') || [];
    for (const edge of startEdges) {
      queue.push({
        node: edge.target,
        inputPayload: initialInput,
        sourceNodeName: 'START',
      });
    }

    // 2. Queue processing loop
    while (queue.length > 0) {
      if (ctx.endInvocation || ctx.abortSignal?.aborted) {
        break;
      }

      const item = queue.shift()!;
      const execId = generateExecutionId(ctx, item.node.name);

      const existingState = agentStates[execId] as NodeState | undefined;
      let nodeOutput: unknown = undefined;

      if (
        existingState &&
        isNodeState(existingState) &&
        existingState.status === NodeStatus.COMPLETED &&
        !item.node.rerunOnResume
      ) {
        nodeOutput = existingState.outputPayload;
      } else {
        const effectiveInput =
          existingState?.inputPayload !== undefined
            ? existingState.inputPayload
            : item.inputPayload;
        const stateRecord: NodeState = {
          executionId: execId,
          nodeName: item.node.name,
          status: NodeStatus.RUNNING,
          inputPayload: effectiveInput,
          timestamp: Date.now(),
        };
        agentStates[execId] = stateRecord;

        try {
          const generator = runWithRetry(
            () => item.node.run(ctx, effectiveInput),
            item.node.retryConfig,
            ctx.abortSignal,
          );

          const yieldedEvents: Event[] = [];
          const {output, isPausedHitl} = await consumeGenerator(
            generator,
            async (event) => {
              yieldedEvents.push(event);
            },
          );

          for (const ev of yieldedEvents) {
            yield ev;
          }

          if (isPausedHitl || ctx.endInvocation || ctx.abortSignal?.aborted) {
            stateRecord.status = NodeStatus.PAUSED_HITL;
            stateRecord.timestamp = Date.now();
            ctx.endInvocation = true;
            break;
          }

          nodeOutput =
            output !== undefined
              ? output
              : (item.node.lastOutputPayload ??
                stateRecord.lastOutputPayload ??
                item.inputPayload);
          stateRecord.status = NodeStatus.COMPLETED;
          stateRecord.outputPayload = nodeOutput;
          stateRecord.timestamp = Date.now();
        } catch (error: unknown) {
          stateRecord.status = NodeStatus.FAILED;
          stateRecord.errorMessage =
            error instanceof Error ? error.message : String(error);
          stateRecord.timestamp = Date.now();
          throw error;
        }
      }

      // 3. Evaluate outgoing edges and enqueue successors whose triggers are satisfied
      const outgoingEdges = this.graph.adjacencyList.get(item.node.name) || [];
      let hasRoutingEdges = false;
      let matchedSpecificRoute = false;
      let defaultRouteEdge: (typeof outgoingEdges)[0] | undefined;

      for (const edge of outgoingEdges) {
        if (!edge.trigger) {
          queue.push({
            node: edge.target,
            inputPayload: nodeOutput,
            sourceNodeName: item.node.name,
          });
          continue;
        }

        hasRoutingEdges = true;
        if (edge.trigger.isDefaultRoute()) {
          defaultRouteEdge = edge;
          continue;
        }

        const triggerSatisfied = await edge.trigger.evaluate(ctx, nodeOutput);
        if (triggerSatisfied) {
          matchedSpecificRoute = true;
          queue.push({
            node: edge.target,
            inputPayload: nodeOutput,
            sourceNodeName: item.node.name,
          });
        }
      }

      if (hasRoutingEdges && !matchedSpecificRoute && defaultRouteEdge) {
        queue.push({
          node: defaultRouteEdge.target,
          inputPayload: nodeOutput,
          sourceNodeName: item.node.name,
        });
      }
    }

    if (this.options.outputKey) {
      const finalStates: Record<string, unknown> = {};
      for (const state of Object.values(agentStates)) {
        if (isNodeState(state) && state.status === NodeStatus.COMPLETED) {
          finalStates[state.nodeName] = state.outputPayload;
        }
      }
      agentStates[this.options.outputKey] = finalStates;
    }
  }
}

/**
 * Gets or initializes the `agentStates` record on the invocation context.
 */
export function getOrInitAgentStates(
  ctx: InvocationContext,
): Record<string, unknown> {
  const unknownCtx = ctx as unknown as Record<string, unknown>;
  if (!unknownCtx.agentStates || typeof unknownCtx.agentStates !== 'object') {
    unknownCtx.agentStates = {};
  }
  return unknownCtx.agentStates as Record<string, unknown>;
}

/**
 * Generates a deterministic execution ID for a node based on the context branch and node name.
 */
export function generateExecutionId(
  ctx: InvocationContext,
  nodeName: string,
): string {
  const branchPrefix = ctx.branch ? `${ctx.branch}.` : '';
  return `exec_node_${branchPrefix}${nodeName}`;
}

/**
 * Checks whether an event signals a Human-in-the-Loop pause (`RequestInput`).
 */
export function isHitlPauseEvent(event: Event): boolean {
  if (!event) return false;
  if (event.actions && typeof event.actions === 'object') {
    if (
      'requestInput' in event.actions &&
      Boolean((event.actions as Record<string, unknown>).requestInput)
    ) {
      return true;
    }
  }
  if (
    'requestInput' in event &&
    Boolean((event as Record<string, unknown>).requestInput)
  ) {
    return true;
  }
  return false;
}
