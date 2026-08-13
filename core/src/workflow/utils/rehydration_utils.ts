/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reconstructs workflow node state from prior session events, so a resumed
 * workflow can fast-forward completed nodes and resolve pending interrupts.
 *
 * Ported (static-graph subset) from `google/adk-python`
 * `workflow/utils/_rehydration_utils.py`. The chronological sequence barrier
 * for deterministic parallel/dynamic replay is a Phase 5b continuation.
 */

import {requiresUserInput} from '../../agents/user_input_request.js';
import {Event} from '../../events/event.js';
import {RouteValue} from '../graph.js';
import type {NodeContext, NodeResult} from '../node_context.js';
import {
  interruptResponseMismatch,
  responseSchemasByInterruptId,
} from './hitl_utils.js';

const RESULT_KEY = 'result';

/** Reconstructed state for a single node, keyed by node name. */
export interface RehydratedNode {
  /** The node's cached output from a prior run, if it produced one. */
  output?: unknown;
  /** The route(s) the node emitted, if any (array = multi-route). */
  route?: RouteValue | RouteValue[];
  /** The branch the node ran on. */
  branch?: string;
  /** The input the node was invoked with (captured when it interrupted). */
  input?: unknown;
  /** Interrupt ids the node raised. */
  interruptIds: Set<string>;
  /** Resolved interrupt responses, keyed by interrupt id. */
  resolvedResponses: Map<string, unknown>;
}

/**
 * Narrows session events to the workflow run still in progress, dropping every
 * earlier run that already finished.
 *
 * Rehydration exists to resume a run that paused, so it must not see a run that
 * already completed: the finished nodes' cached outputs would be fast-forwarded
 * into the new run, and the workflow would replay its previous answer instead
 * of acting on the new input.
 *
 * `google/adk-python` scopes this by invocation id, because there a resumed
 * invocation keeps its id. The TypeScript runner mints a fresh invocation id
 * for every turn (`Runner.runAsync`), so a run that spans a pause covers
 * several invocations and an id filter would discard the very outputs resume
 * needs. Runs are delimited by pausing instead:
 *
 *   - An invocation that raised an interrupt ended paused, so it belongs to the
 *     run still in progress.
 *   - An invocation that emitted node events without raising one ran to
 *     completion; it is the boundary, and it and everything before it are
 *     dropped.
 *
 * The current invocation is always kept: it is in progress by definition, and
 * it carries the user function responses that resolve the pending interrupts.
 */
export function eventsForCurrentRun(
  events: Event[],
  currentInvocationId: string,
): Event[] {
  // Ordered summary of each prior invocation that emitted workflow node events.
  const priorRuns: Array<{
    start: number;
    invocationId?: string;
    paused: boolean;
  }> = [];
  let currentStart = events.length;
  // Not every node event carries an invocation id: events minted inside the
  // engine (a RequestInput interrupt, for one) are enriched with author, path
  // and branch but no id. Such an event belongs to the invocation whose events
  // it sits among, so carry the last id seen forward rather than let it open a
  // phantom run of its own — which would put the boundary in the middle of a
  // paused run and re-execute nodes that had already completed.
  let lastInvocationId: string | undefined;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const invocationId = event.invocationId || lastInvocationId;
    if (event.invocationId) {
      lastInvocationId = event.invocationId;
    }
    if (invocationId === currentInvocationId) {
      if (currentStart === events.length) {
        currentStart = i;
      }
      continue;
    }
    if (!event.nodeInfo?.path) {
      continue;
    }
    let entry = priorRuns[priorRuns.length - 1];
    if (!entry || entry.invocationId !== invocationId) {
      entry = {start: i, invocationId, paused: false};
      priorRuns.push(entry);
    }
    if (raisedInterrupt(event)) {
      entry.paused = true;
    }
  }

  // Walk back over the prior invocations that ended paused; the earliest of
  // them starts the run still in progress.
  let boundary = currentStart;
  for (let i = priorRuns.length - 1; i >= 0 && priorRuns[i].paused; i--) {
    boundary = priorRuns[i].start;
  }

  return events.slice(boundary);
}

/**
 * Whether an event paused the run for a human: it carries one of the three
 * `adk_request_*` calls (input, credential, or tool confirmation).
 *
 * Deliberately NOT `longRunningToolIds`, which marks any tool declared
 * `isLongRunning` — a run that merely used one is not waiting on a person.
 */
function raisedInterrupt(event: Event): boolean {
  return requiresUserInput(event);
}

/**
 * Scans session events and reconstructs per-node state (outputs, routes, raised
 * interrupts, and resolved interrupt responses).
 *
 * When `parentPath` is given, reconstruction is scoped to that path's DIRECT
 * children (keyed by child name), so nested workflows whose nodes share a name
 * do not collide on resume. When omitted, nodes are keyed by their path leaf
 * (utility mode, robust to author rewrite).
 */
export function reconstructNodeStates(
  events: Event[],
  parentPath?: string,
): Map<string, RehydratedNode> {
  if (parentPath) {
    return reconstruct(events, (event) =>
      event.nodeInfo?.path
        ? directChildName(event.nodeInfo.path, parentPath)
        : undefined,
    );
  }
  return reconstruct(events, (event) =>
    event.nodeInfo?.path ? nodeNameFromPath(event.nodeInfo.path) : event.author,
  );
}

/**
 * Like {@link reconstructNodeStates} but keyed by the full node path
 * (`wf.node@runId`), so distinct dynamic (`ctx.runNode`) iterations are tracked
 * separately for per-run resume/dedup.
 */
export function reconstructNodeStatesByPath(
  events: Event[],
): Map<string, RehydratedNode> {
  return reconstruct(events, (event) => event.nodeInfo?.path ?? event.author);
}

/**
 * Every interrupt raised in `events` that now has an accepted reply, as
 * interrupt id -> value.
 *
 * Flat and unscoped, unlike {@link reconstructNodeStates}: interrupt ids are
 * unique, and a reply has to reach whoever raised it however deep that sits. A
 * dynamic (`ctx.runNode`) child or a nested workflow's leaf is keyed out of the
 * per-parent view, so a scoped map silently drops its answer and the run pauses
 * on the same question forever.
 *
 * A reply that does not match the schema its interrupt declared resolves
 * nothing. It throws while it is the turn being processed, so the client hears
 * about it once, and is skipped on every replay after that (see
 * {@link interruptResponseMismatch}).
 */
export function resolvedInterruptResponses(
  events: Event[],
): Map<string, unknown> {
  const responseSchemas = responseSchemasByInterruptId(events);
  const newestUserTurn = lastUserEvent(events);
  const raised = new Set<string>();
  const resolved = new Map<string, unknown>();

  for (const event of events) {
    if (event.author === 'user' && event.content?.parts) {
      for (const part of event.content.parts) {
        const fr = part.functionResponse;
        if (!fr?.id || !raised.has(fr.id)) {
          continue;
        }
        const response = unwrapResponse(fr.response);
        const mismatch = interruptResponseMismatch(
          fr.id,
          response,
          responseSchemas.get(fr.id),
        );
        if (mismatch) {
          if (event === newestUserTurn) {
            throw new Error(mismatch);
          }
          continue;
        }
        resolved.set(fr.id, response);
      }
      continue;
    }
    for (const id of event.longRunningToolIds ?? []) {
      raised.add(id);
    }
  }

  return resolved;
}

/**
 * Reconstructs each node's prior runs in order, rather than merging them into
 * one record per node.
 *
 * A node the graph routes back to runs more than once, and a pause can fall
 * between two of its runs — the revise loop in the request-input samples pauses
 * on `request_human_review@1`, resumes, and pauses again on `@2`. Merged into a
 * single record those two runs are indistinguishable, and the resumed turn
 * replays the first run's answer forever. `google/adk-python` avoids this by
 * keying its recovered executions on `name@run_id`; TypeScript node paths carry
 * no run id for static graph nodes, so the runs are recovered positionally
 * instead: the Nth activation in the resumed turn matches the Nth prior run.
 *
 * A run is closed once it has produced an output, a route, or an interrupt, so
 * the next event for that node opens the next run. Events a run emits before
 * that (messages, state deltas) accumulate into the run in progress.
 */
export function reconstructNodeRuns(
  events: Event[],
  parentPath?: string,
): Map<string, RehydratedNode[]> {
  return reconstructRuns(events, keyFn(parentPath));
}

function keyFn(parentPath?: string): (event: Event) => string | undefined {
  if (parentPath) {
    return (event) =>
      event.nodeInfo?.path
        ? directChildName(event.nodeInfo.path, parentPath)
        : undefined;
  }
  return (event) =>
    event.nodeInfo?.path ? nodeNameFromPath(event.nodeInfo.path) : event.author;
}

/** Whether a run has reached a terminal result, so the next event is a new run. */
function isRunClosed(node: RehydratedNode): boolean {
  return (
    node.output !== undefined ||
    node.route !== undefined ||
    node.interruptIds.size > 0
  );
}

/** Shared scan that groups node events by the key returned by `keyFor`. */
function reconstruct(
  events: Event[],
  keyFor: (event: Event) => string | undefined,
): Map<string, RehydratedNode> {
  const merged = new Map<string, RehydratedNode>();
  for (const [key, runs] of reconstructRuns(events, keyFor)) {
    const node: RehydratedNode = {
      interruptIds: new Set(),
      resolvedResponses: new Map(),
    };
    for (const run of runs) {
      if (run.output !== undefined) {
        node.output = run.output;
        node.branch = run.branch;
      }
      if (run.route !== undefined) node.route = run.route;
      if (run.input !== undefined) node.input = run.input;
      for (const id of run.interruptIds) node.interruptIds.add(id);
      for (const [id, value] of run.resolvedResponses) {
        node.resolvedResponses.set(id, value);
      }
    }
    merged.set(key, node);
  }
  return merged;
}

function reconstructRuns(
  events: Event[],
  keyFor: (event: Event) => string | undefined,
): Map<string, RehydratedNode[]> {
  const nodes = new Map<string, RehydratedNode[]>();
  const interruptOwner = new Map<string, RehydratedNode>();
  const resolved = resolvedInterruptResponses(events);

  const currentRun = (name: string): RehydratedNode => {
    let runs = nodes.get(name);
    if (!runs) {
      runs = [];
      nodes.set(name, runs);
    }
    const open = runs[runs.length - 1];
    if (open && !isRunClosed(open)) {
      return open;
    }
    const run: RehydratedNode = {
      interruptIds: new Set(),
      resolvedResponses: new Map(),
    };
    runs.push(run);
    return run;
  };

  for (const event of events) {
    // 1. User function responses resolving prior interrupts. A reply the
    //    schema check refused is absent from `resolved`, leaving its interrupt
    //    unresolved so the run pauses there again.
    if (event.author === 'user' && event.content?.parts) {
      for (const part of event.content.parts) {
        const fr = part.functionResponse;
        if (fr?.id && interruptOwner.has(fr.id) && resolved.has(fr.id)) {
          interruptOwner
            .get(fr.id)!
            .resolvedResponses.set(fr.id, resolved.get(fr.id));
        }
      }
      continue;
    }

    // 2. Node events.
    const key = keyFor(event);
    if (!key) {
      continue;
    }
    const node = currentRun(key);
    if (event.output !== undefined) {
      node.output = event.output;
      node.branch = event.branch;
    }
    if (event.route !== undefined) {
      node.route = event.route as RouteValue | RouteValue[];
    }
    for (const id of event.longRunningToolIds ?? []) {
      node.interruptIds.add(id);
      interruptOwner.set(id, node);
    }
    // Capture the node's original input, stashed on the interrupt event, so a
    // resumed waiting node re-runs with it (not the resume message). Guard the
    // read since `agentState` is an unknown, arbitrarily-shaped payload.
    const agentState = event.actions?.agentState;
    if (isRecord(agentState) && 'input' in agentState) {
      node.input = agentState.input;
    }
  }

  return nodes;
}

/**
 * The most recent user event, i.e. the turn currently being processed: the
 * runner appends the incoming message before the agent runs, so a reply found
 * there is one the caller can still do something about.
 */
function lastUserEvent(events: Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].author === 'user') {
      return events[i];
    }
  }
  return undefined;
}

/**
 * Whether a rehydrated node can be fast-forwarded on resume: it produced a
 * result — an output or a route — and all of its raised interrupts have been
 * resolved.
 */
export function isFastForwardable(node: RehydratedNode): boolean {
  if (node.output === undefined && node.route === undefined) {
    return false;
  }
  for (const id of node.interruptIds) {
    if (!node.resolvedResponses.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * Builds the completion result for a fast-forwarded (cached) node on resume.
 * The node's body is not re-run and its events are NOT re-emitted (they already
 * exist in the session), so this returns a bare {@link NodeResult} rather than a
 * live {@link NodeContext} — the honest type for "cached output, no behaviour".
 */
export function makeFastForwardResult(
  parent: NodeContext,
  prior: RehydratedNode,
): NodeResult {
  return {
    output: prior.output,
    route: prior.route,
    branch: prior.branch ?? parent.branch,
    interruptIds: [],
  };
}

/** Extracts the node name (leaf, without run id) from a dotted node path. */
export function nodeNameFromPath(path: string): string {
  const leaf = path.split(/[./]/).pop() ?? path;
  return leaf.split('@')[0];
}

/**
 * Returns the child node name if `path` is a DIRECT child of `parentPath`
 * (e.g. `parent.child` -> `child`, `parent.child@2` -> `child`), or `undefined`
 * for a non-descendant or a deeper descendant (e.g. `parent.sub.child`). Used to
 * scope rehydration to a single workflow's own nodes.
 */
function directChildName(path: string, parentPath: string): string | undefined {
  const prefix = `${parentPath}.`;
  if (!path.startsWith(prefix)) {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  if (rest.includes('.')) {
    return undefined; // a deeper descendant, not a direct child
  }
  return rest.split('@')[0];
}

/** Narrows an unknown value to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unwraps a `{result: value}` FunctionResponse envelope to the bare value.
 *
 * Every string value is JSON-parsed when it parses, because the envelope does
 * not say whether the text is structured: a client answering a `RequestInput`
 * that declared a `responseSchema` sends the object as text (the web frontend
 * wraps whatever the user submitted as `{result: text}`), and the node expects
 * the object back. Text that is not JSON — "approve", "shorter" — is returned
 * as-is, and so a plain answer that happens to be valid JSON is converted too:
 * "42" comes back as a number, "true" as a boolean. That is deliberate parity
 * with Python's `_unwrap_response`, and harmless downstream —
 * {@link interruptResponseMismatch} exempts scalars from the schema check.
 */
export function unwrapResponse(response: unknown): unknown {
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    Object.keys(response).length === 1 &&
    RESULT_KEY in response
  ) {
    const value = (response as Record<string, unknown>)[RESULT_KEY];
    return typeof value === 'string' ? parseJsonIfPossible(value) : value;
  }
  return response;
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
