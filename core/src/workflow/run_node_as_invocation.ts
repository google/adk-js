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
import {BaseNode, toContent} from './base_node.js';
import type {RunnableNode} from './graph.js';
import {NodeContext} from './node_context.js';
import {
  eventsForCurrentRun,
  reconstructNodeStates,
} from './utils/rehydration_utils.js';
import {buildNode, isNodeLike} from './utils/workflow_graph_utils.js';
import {isWorkflow, Workflow} from './workflow.js';

/**
 * What can be run as the root of an invocation: an agent, or a `Workflow` the
 * runner drives as a node. See {@link isRunnableRoot}.
 */
export type RunnableRoot = BaseAgent | Workflow;

/** Options for {@link runNodeAsInvocation}. */
export interface RunNodeAsInvocationOptions {
  /**
   * Author for the event announcing the node's output, when one is needed.
   * Defaults to the node's own name.
   */
  author?: string;
}

/**
 * Runs a node as a whole invocation, turning it into a stream of events.
 *
 * This is the seam between the two execution shapes ADK has. A node is driven
 * by pushing events into a channel while something else drains it; a caller of
 * an invocation expects to pull events out of a generator. Bridging them means
 * three things: give the node a root {@link NodeContext} to run in, derive its
 * input from the user's message, and pump the channel.
 *
 * adk-python does the same work in `Runner._run_node_async`, over
 * `ic._event_queue` rather than a local queue. It lives as a free function
 * rather than a method because the runner is not its only caller: anything that
 * has to run a node as a whole invocation goes through here.
 */
export async function* runNodeAsInvocation(
  node: BaseNode,
  ic: InvocationContext,
  options: RunNodeAsInvocationOptions = {},
): AsyncGenerator<Event, void, void> {
  const author = options.author ?? node.name;
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: author,
    // Interactive resume: if the node is paused on an interrupt and the user
    // replies with plain text (not a structured function response), feed that
    // text to the pending interrupt(s). Structured function responses are still
    // resolved by the workflow's own rehydration.
    resumeInputs: resumeInputsFromPlainText(ic),
  });

  const input = extractNodeInput(ic.userContent);

  let interrupted = false;
  const settle = (async () => {
    try {
      const nodeCtx = await root.runNode(node, input, {useAsOutput: true});
      interrupted = nodeCtx.interruptIds.length > 0;
      channel.close();
    } catch (err) {
      channel.fail(err);
    }
  })();

  // The last output handed to the caller, tracked so the node's own output is
  // not delivered twice.
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
    // the producer stops pushing into a queue nobody drains, and await `settle`
    // so its cleanup runs and errors surface. Idempotent on the normal path
    // (the channel is already closed and `settle` resolved).
    channel.close();
    await settle;
  }

  // The contract this keeps is that the node's output is the last output on the
  // stream, so a consumer can read the result by taking the last one. When the
  // terminal node already put it there — the ordinary case — saying it again
  // would deliver one node output as two data events. When it did not, the
  // value still has to be announced: a `dynamicEntry` can return something it
  // computed rather than a child's value, a node can set `ctx.output` without
  // emitting, and a later branch can emit after the node that produced the
  // result.
  //
  // Deciding after the drain, rather than when the node settles, is what makes
  // this exact: by then every node event has been seen, whereas `root.output`
  // is only assigned once the whole run has finished.
  const alreadyLast = sawOutput && Object.is(lastOutput, root.output);
  if (!interrupted && root.output !== undefined && !alreadyLast) {
    yield createEvent({
      author,
      invocationId: ic.invocationId,
      branch: ic.branch,
      content: toContent(root.output),
      output: root.output,
    });
  }
}

/**
 * When the run is paused on exactly one unresolved interrupt and the incoming
 * message is plain text (not a structured function response), maps that text to
 * the single pending interrupt id so an interactive client (e.g. `adk run`) can
 * resume a HITL/auth pause by simply typing a reply.
 *
 * If more than one interrupt is pending, a plain-text reply is ambiguous — it
 * would be broadcast to every pause and at least one node would resume with
 * data the user never gave it — so it is ignored here. Addressing a specific
 * pause in a multi-interrupt workflow requires structured function responses
 * (resolved by the workflow's own rehydration).
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
  for (const nodeState of reconstructNodeStates(events).values()) {
    for (const id of nodeState.interruptIds) {
      if (!nodeState.resolvedResponses.has(id)) {
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
 * Derives the node input from the user message: plain text when the content is
 * text-only, otherwise the raw `Content` (nodes coerce as needed).
 */
function extractNodeInput(content?: Content): unknown {
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
 * Whether a value is already a root, and so is worth handing to
 * {@link asRunnableRoot}.
 *
 * An agent always is. A `Workflow` is because the runner drives it as a node
 * rather than running it through `runAsync`.
 *
 * Used where a root is *discovered* rather than passed — the agent loader
 * sifting a module's exports — so a workflow export is found the same way an
 * agent export is.
 *
 * Deliberately narrower than what {@link asRunnableRoot} accepts: a passed root
 * is a statement of intent, while a discovered one is a guess, and every module
 * exports functions that are not meant to be the app.
 */
export function isRunnableRoot(value: unknown): value is RunnableRoot {
  return isBaseAgent(value) || isWorkflow(value);
}

/**
 * Normalizes whatever was handed in as a root into a {@link RunnableRoot}.
 *
 * An agent and a workflow are both roots already and pass through as
 * themselves. Anything else node-like — a tool, a plain function, an
 * already-built node — becomes the single node of a one-node workflow, exactly
 * what `edges: [['START', value]]` spells by hand, so `{agent: node}` and
 * `{agent: new Workflow({edges: [['START', node]]})}` are the same request
 * spelled two ways.
 *
 * The value is built before it reaches the graph parser, which would build it
 * anyway, because the built node is what carries the name and description the
 * wrapping workflow takes.
 *
 * @throws if `root` is not something an edge would accept.
 */
export function asRunnableRoot(root: RunnableNode): RunnableRoot {
  if (isRunnableRoot(root)) {
    return root;
  }
  // Guard the untyped callers (the agent loader reads whatever a module
  // exports). Widened to `unknown` because the guard is for values the type
  // already excludes.
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
  const built = buildNode(value);
  return new Workflow({
    name: built.name,
    description: built.description,
    edges: [['START', built]],
  });
}
