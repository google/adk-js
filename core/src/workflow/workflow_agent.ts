/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';
import type {RunnableNode} from './graph.js';
import {runNodeAsInvocation} from './run_node_as_invocation.js';
import {buildNode, isNodeLike} from './utils/workflow_graph_utils.js';
import {isWorkflow, Workflow, WorkflowConfig} from './workflow.js';

const WORKFLOW_AGENT_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.workflow.workflowAgent',
);

/** Options for a {@link WorkflowAgent}. */
export interface WorkflowAgentConfig {
  name?: string;
  description?: string;
}

/**
 * Adapts a {@link Workflow} (a `BaseNode`) into a `BaseAgent` so it can be run by
 * the standard ADK `Runner`.
 *
 * It sets up the event channel bridge: the workflow's node execution pushes
 * events into the channel while this agent's `runAsyncImpl` drains and re-yields
 * them to the runtime. The user message (`ctx.userContent`) becomes the
 * workflow input.
 */
@experimental
export class WorkflowAgent extends BaseAgent {
  readonly [WORKFLOW_AGENT_SIGNATURE_SYMBOL] = true;

  readonly workflow: Workflow;

  /**
   * Wraps an existing {@link Workflow}, or anything an edge accepts — an agent,
   * a tool, a plain function, or an already-built node — which becomes the one
   * node of a one-node workflow, so `new WorkflowAgent(myAgent)` works without
   * spelling out `new Workflow({name, edges: [['START', myAgent]]})`.
   *
   * The agent's name/description default to the workflow's (for a bare value,
   * to the built node's); pass `config` to override them.
   */
  constructor(nodeLike: RunnableNode, config?: WorkflowAgentConfig);
  /**
   * Convenience form: pass the {@link Workflow} constructor options directly and
   * the workflow is created internally, so you can write
   * `new WorkflowAgent({name, edges})` instead of
   * `new WorkflowAgent(new Workflow({name, edges}))`. The agent's name and
   * description come from the config.
   */
  constructor(config: WorkflowConfig);
  constructor(
    nodeLikeOrConfig: RunnableNode | WorkflowConfig,
    config: WorkflowAgentConfig = {},
  ) {
    const workflow = toWorkflow(nodeLikeOrConfig);
    super({
      name: config.name ?? workflow.name,
      description: config.description ?? workflow.description,
    });
    this.workflow = workflow;
  }

  protected async *runAsyncImpl(
    ic: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // The whole of this agent's behaviour. Kept here only so a workflow can be
    // used where a `BaseAgent` is required; the runner now calls
    // `runNodeAsInvocation` directly for a workflow handed to it.
    yield* runNodeAsInvocation(this.workflow, ic, {author: this.name});
  }

  // eslint-disable-next-line require-yield -- runLiveImpl must be an AsyncGenerator per BaseAgent, but live mode is unsupported so it only throws
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('WorkflowAgent does not support live mode.');
  }
}

/**
 * Resolves a constructor argument to the {@link Workflow} the agent adapts.
 *
 * A workflow is used as it is. Anything else node-like becomes the single node
 * of a one-node workflow — exactly what `edges: [['START', value]]` spells by
 * hand — rather than being adapted directly, so
 * {@link WorkflowAgent.workflow} stays a `Workflow` for every caller that reads
 * it (the dev UI's graph renderer, for one).
 *
 * Everything else is {@link WorkflowConfig} to build a workflow from. The two
 * cannot be confused: a config is a plain object literal, and no builder
 * matches one.
 *
 * The value is built before it reaches the graph parser, which would build it
 * anyway, because the built node is what carries the name and description the
 * workflow — and through it the agent — takes.
 */
function toWorkflow(value: RunnableNode | WorkflowConfig): Workflow {
  if (!isNodeLike(value)) {
    return new Workflow(value);
  }
  if (isWorkflow(value)) {
    return value;
  }
  const built = buildNode(value);
  return new Workflow({
    name: built.name,
    description: built.description,
    edges: [['START', built]],
  });
}

/** Whether `value` is a graph `WorkflowAgent` (brand check, not `instanceof`). */
export function isGraphWorkflowAgent(value: unknown): value is WorkflowAgent {
  return (
    typeof value === 'object' &&
    value !== null &&
    WORKFLOW_AGENT_SIGNATURE_SYMBOL in value &&
    value[WORKFLOW_AGENT_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Normalizes whatever was handed in as a root into a `BaseAgent`.
 *
 * An agent is already a node (`BaseAgent extends BaseNode`), so the interesting
 * case is the other direction: a bare node — a `Workflow`, most usefully — has
 * no `runAsync`, and the things that consume a root (the runner, an `App`, the
 * agent loader) all drive agents. `WorkflowAgent` is the existing bridge, so
 * the node is wrapped here rather than each consumer growing its own second
 * execution path.
 *
 * The accepted set is exactly what `WorkflowAgent` accepts, which is what an
 * edge accepts: a workflow passes through the wrap as itself, and any other
 * node-like value becomes the single node of a one-node workflow, fed the user
 * message and streamed back from. Keeping the two in step matters because
 * `new Runner({agent: node})` and `new Runner({agent: new WorkflowAgent(node)})`
 * are the same request spelled two ways.
 *
 * adk-python reaches the same place from the other side: its runner stores a
 * `BaseNode` and branches to the node runtime only when the root is a node that
 * is *not* an agent, leaving agents on the classic path.
 *
 * @throws if `root` is not something an edge would accept.
 */
export function asRootAgent(root: RunnableNode): BaseAgent {
  if (isBaseAgent(root)) {
    return root;
  }
  // Guard the untyped callers (the agent loader reads whatever a module
  // exports). Widened to `unknown` because the guard is for values the type
  // already excludes: without it a non-node-like value would be read as a
  // `WorkflowConfig` and fail somewhere inside the graph parser instead.
  const value: unknown = root;
  if (!isNodeLike(value) || value === 'START') {
    const described =
      value === 'START'
        ? "the 'START' sentinel"
        : ((value as {constructor?: {name?: string}})?.constructor?.name ??
          typeof value);
    throw new TypeError(
      `Cannot use ${described} as a root: expected a BaseAgent, a Workflow, ` +
        'or a node-like value (a node, a tool, or a function).',
    );
  }
  return new WorkflowAgent(value);
}

/**
 * Whether a value looks like an intended root, and so is worth handing to
 * {@link asRootAgent}.
 *
 * Used where roots are *discovered* rather than passed — the agent loader
 * sifting a module's exports — so that a `Workflow` export is found the same
 * way an agent export is.
 *
 * Deliberately narrower than what {@link asRootAgent} accepts: a passed root is
 * a statement of intent, while a discovered one is a guess, and every module
 * exports functions that are not meant to be the app.
 */
export function isRootAgentLike(value: unknown): value is BaseAgent | Workflow {
  return isBaseAgent(value) || isWorkflow(value);
}
