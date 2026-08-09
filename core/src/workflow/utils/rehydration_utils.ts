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

import {Event} from '../../events/event.js';
import {RouteValue} from '../graph.js';
import type {NodeContext, NodeResult} from '../node_context.js';

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
  invocationId?: string,
): Map<string, RehydratedNode> {
  if (parentPath) {
    return reconstruct(
      events,
      (event) =>
        event.nodeInfo?.path
          ? directChildName(event.nodeInfo.path, parentPath)
          : undefined,
      invocationId,
    );
  }
  return reconstruct(
    events,
    (event) =>
      event.nodeInfo?.path
        ? nodeNameFromPath(event.nodeInfo.path)
        : event.author,
    invocationId,
  );
}

/**
 * Like {@link reconstructNodeStates} but keyed by the full node path
 * (`wf.node@runId`), so distinct dynamic (`ctx.runNode`) iterations are tracked
 * separately for per-run resume/dedup.
 */
export function reconstructNodeStatesByPath(
  events: Event[],
  invocationId?: string,
): Map<string, RehydratedNode> {
  return reconstruct(
    events,
    (event) => event.nodeInfo?.path ?? event.author,
    invocationId,
  );
}

/** Shared scan that groups node events by the key returned by `keyFor`. */
function reconstruct(
  events: Event[],
  keyFor: (event: Event) => string | undefined,
  invocationId?: string,
): Map<string, RehydratedNode> {
  const nodes = new Map<string, RehydratedNode>();
  const interruptOwner = new Map<string, string>();

  const getNode = (name: string): RehydratedNode => {
    let node = nodes.get(name);
    if (!node) {
      node = {interruptIds: new Set(), resolvedResponses: new Map()};
      nodes.set(name, node);
    }
    return node;
  };

  for (const event of events) {
    if (invocationId && event.invocationId !== invocationId) {
      continue;
    }

    // 1. User function responses resolving prior interrupts.
    if (event.author === 'user' && event.content?.parts) {
      for (const part of event.content.parts) {
        const fr = part.functionResponse;
        if (fr?.id && interruptOwner.has(fr.id)) {
          const owner = interruptOwner.get(fr.id)!;
          getNode(owner).resolvedResponses.set(
            fr.id,
            unwrapResponse(fr.response),
          );
        }
      }
      continue;
    }

    // 2. Node events.
    const key = keyFor(event);
    if (!key) {
      continue;
    }
    const node = getNode(key);
    if (event.output !== undefined) {
      node.output = event.output;
      node.branch = event.branch;
    }
    if (event.route !== undefined) {
      node.route = event.route as RouteValue | RouteValue[];
    }
    for (const id of event.longRunningToolIds ?? []) {
      node.interruptIds.add(id);
      interruptOwner.set(id, key);
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
 * Whether a rehydrated node can be fast-forwarded on resume: it produced an
 * output and all of its raised interrupts have been resolved.
 */
export function isFastForwardable(node: RehydratedNode): boolean {
  if (node.output === undefined) {
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

/** Unwraps a `{result: value}` FunctionResponse envelope to the bare value. */
export function unwrapResponse(response: unknown): unknown {
  if (
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    Object.keys(response).length === 1 &&
    RESULT_KEY in response
  ) {
    return (response as Record<string, unknown>)[RESULT_KEY];
  }
  return response;
}
