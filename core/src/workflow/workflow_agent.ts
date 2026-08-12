/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event} from '../events/event.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {experimental} from '../utils/experimental.js';
import {toContent} from './base_node.js';
import type {RunnableNode} from './graph.js';
import {NodeContext} from './node_context.js';
import {
  eventsForCurrentRun,
  reconstructNodeStates,
} from './utils/rehydration_utils.js';
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
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: this.name,
      // Interactive resume: if the workflow is paused on an interrupt and the
      // user replies with plain text (not a structured function response), feed
      // that text to the pending interrupt(s). Structured function responses are
      // still resolved by the workflow's own rehydration.
      resumeInputs: resumeInputsFromPlainText(ic),
    });

    const input = extractWorkflowInput(ic.userContent);

    let interrupted = false;
    const settle = (async () => {
      try {
        const wfCtx = await root.runNode(this.workflow, input, {
          useAsOutput: true,
        });
        interrupted = wfCtx.interruptIds.length > 0;
        channel.close();
      } catch (err) {
        channel.fail(err);
      }
    })();

    // The last output handed to the caller, tracked so the workflow's own
    // output is not delivered twice.
    let lastOutput: unknown;
    let sawOutput = false;

    try {
      for await (const event of channel) {
        if (event.output !== undefined) {
          lastOutput = event.output;
          sawOutput = true;
        }
        yield event;
      }
      await settle;
    } finally {
      // Ensure a single exit path if the consumer stops early (breaks its
      // for-await, or the Runner cancels the invocation): close the channel so
      // the workflow's producer stops pushing into a queue nobody drains, and
      // await `settle` so its cleanup runs and errors surface. Idempotent on the
      // normal path (the channel is already closed and `settle` resolved).
      channel.close();
      await settle;
    }

    // The contract this keeps is that the workflow's output is the last output
    // on the stream, so a consumer can read the result by taking the last one.
    // When the terminal node already put it there — the ordinary case — saying
    // it again would deliver one node output as two data events. When it did
    // not, the value still has to be announced: a `dynamicEntry` can return
    // something it computed rather than a child's value, a node can set
    // `ctx.output` without emitting, and a later branch can emit after the
    // node that produced the result.
    //
    // Deciding after the drain, rather than when the workflow settles, is what
    // makes this exact: by then every node event has been seen, whereas
    // `root.output` is only assigned once the whole workflow has finished.
    const alreadyLast = sawOutput && Object.is(lastOutput, root.output);
    if (!interrupted && root.output !== undefined && !alreadyLast) {
      yield createEvent({
        author: this.name,
        invocationId: ic.invocationId,
        branch: ic.branch,
        content: toContent(root.output),
        output: root.output,
      });
    }
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
 * When the workflow is paused on exactly one unresolved interrupt and the
 * incoming message is plain text (not a structured function response), maps that
 * text to the single pending interrupt id so an interactive client (e.g. `adk
 * run`) can resume a HITL/auth pause by simply typing a reply.
 *
 * If more than one interrupt is pending, a plain-text reply is ambiguous — it
 * would be broadcast to every pause and at least one node would resume with data
 * the user never gave it — so it is ignored here. Addressing a specific pause in
 * a multi-interrupt workflow requires structured function responses (resolved by
 * the workflow's own rehydration).
 */
function resumeInputsFromPlainText(
  ic: InvocationContext,
): Record<string, unknown> {
  const parts = ic.userContent?.parts ?? [];
  const isPlainText =
    parts.length > 0 && parts.every((p) => typeof p.text === 'string');
  if (!isPlainText) {
    return {};
  }
  const text = parts.map((p) => p.text).join('');

  const pending = new Set<string>();
  // Scoped to the run still in progress: a pause belonging to a run that
  // already finished is not resumable, and must not swallow the new message.
  const events = eventsForCurrentRun(ic.session?.events ?? [], ic.invocationId);
  for (const node of reconstructNodeStates(events).values()) {
    for (const id of node.interruptIds) {
      if (!node.resolvedResponses.has(id)) {
        pending.add(id);
      }
    }
  }

  // Only the unambiguous single-pause case is resumable by plain text.
  if (pending.size !== 1) {
    return {};
  }
  const [id] = pending;
  return {[id]: text};
}

/**
 * Derives the workflow input from the user message: plain text when the content
 * is text-only, otherwise the raw `Content` (nodes coerce as needed).
 */
function extractWorkflowInput(content?: Content): unknown {
  if (!content) {
    return undefined;
  }
  const parts = content.parts ?? [];
  if (parts.length > 0 && parts.every((p) => typeof p.text === 'string')) {
    return parts.map((p) => p.text).join('');
  }
  return content;
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
