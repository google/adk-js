/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {BaseNode} from './base_node.js';
import {
  DynamicEntryFunction,
  DynamicNodeScheduler,
} from './dynamic_node_scheduler.js';
import {NodeRunner} from './node_runner.js';
import {GraphEdge} from './utils/graph_parser.js';

/**
 * A unique symbol to identify ADK Workflow agent instances.
 */
const WORKFLOW_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow');

/**
 * Type guard to check if an object is an instance of Workflow.
 * @param obj The object to check.
 * @returns True if the object is an instance of Workflow, false otherwise.
 */
export function isWorkflow(obj: unknown): obj is Workflow {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    WORKFLOW_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[WORKFLOW_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Configuration options for creating a Workflow agent.
 * Workflows must define exactly one of `edges` (for static DAG execution) or `dynamicEntry` (for programmatic execution).
 */
export interface WorkflowConfig extends BaseAgentConfig {
  /**
   * Static graph edge definitions (e.g., `["START", nodeA, nodeB]` or `[routerNode, { ROUTE_A: nodeC }]`).
   * Mutually exclusive with `dynamicEntry`.
   */
  edges?: GraphEdge[];

  /**
   * Programmatic entry node or async function handler (`async (ctx, input) => ...`) that coordinates
   * child nodes using `ctx.runNode(...)`. Mutually exclusive with `edges`.
   */
  dynamicEntry?: BaseNode | DynamicEntryFunction;

  /**
   * Optional key inside `InvocationContext.agentStates` where the final output of the workflow
   * should be stored upon successful completion.
   */
  outputKey?: string;

  /**
   * If true, the workflow will force re-execution on resumption even if historical outputs exist.
   * Default is false.
   */
  rerunOnResume?: boolean;

  /**
   * If true, allows directed cycles inside static `edges` graph validation.
   * Default is false.
   */
  allowCycles?: boolean;
}

/**
 * The top-level Workflow agent in ADK-JS.
 * Inherits from `BaseAgent` and orchestrates multi-step node execution using either a static graph DAG (`NodeRunner`)
 * or dynamic programmatic scheduling (`DynamicNodeScheduler`).
 */
export class Workflow extends BaseAgent {
  readonly [WORKFLOW_SIGNATURE_SYMBOL] = true;

  readonly edges?: GraphEdge[];
  readonly dynamicEntry?: BaseNode | DynamicEntryFunction;
  readonly outputKey?: string;
  readonly rerunOnResume: boolean;
  readonly allowCycles: boolean;

  constructor(config: WorkflowConfig) {
    super(config);
    if (config.edges && config.dynamicEntry) {
      throw new Error(
        `Workflow "${this.name}" cannot have both "edges" and "dynamicEntry" defined. They are mutually exclusive.`,
      );
    }
    if (!config.edges && !config.dynamicEntry) {
      throw new Error(
        `Workflow "${this.name}" must define either "edges" (for static graphs) or "dynamicEntry" (for dynamic code execution).`,
      );
    }

    this.edges = config.edges;
    this.dynamicEntry = config.dynamicEntry;
    this.outputKey = config.outputKey;
    this.rerunOnResume = config.rerunOnResume ?? false;
    this.allowCycles = config.allowCycles ?? false;
  }

  /**
   * Executes the workflow via text-based or programmatic invocation.
   */
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (context.endOfAgents[this.name]) {
      return;
    }

    if (this.edges) {
      const runner = new NodeRunner(this.edges, {
        outputKey: this.outputKey,
        allowCycles: this.allowCycles,
      });
      yield* runner.runAsync(context, context.userContent);
    } else if (this.dynamicEntry) {
      const scheduler = new DynamicNodeScheduler(this.dynamicEntry, {
        outputKey: this.outputKey,
      });
      yield* scheduler.runAsync(context, context.userContent);
    }

    context.endOfAgents[this.name] = true;
  }

  /**
   * Executes the workflow via audio/video live streaming invocation.
   */
  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}
