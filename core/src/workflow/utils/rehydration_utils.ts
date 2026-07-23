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
import type {NodeContext} from '../node_context.js';

const RESULT_KEY = 'result';

/** Reconstructed state for a single node, keyed by node name. */
export interface RehydratedNode {
  /** The node's cached output from a prior run, if it produced one. */
  output?: unknown;
  /** The route the node emitted, if any. */
  route?: RouteValue;
  /** The branch the node ran on. */
  branch?: string;
  /** Interrupt ids the node raised. */
  interruptIds: Set<string>;
  /** Resolved interrupt responses, keyed by interrupt id. */
  resolvedResponses: Map<string, unknown>;
}

/**
 * Scans session events and reconstructs per-node state (outputs, routes, raised
 * interrupts, and resolved interrupt responses).
 */
export function reconstructNodeStates(
  events: Event[],
): Map<string, RehydratedNode> {
  // Key static-graph nodes by their name (path leaf), robust to author rewrite.
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

/** Shared scan that groups node events by the key returned by `keyFor`. */
function reconstruct(
  events: Event[],
  keyFor: (event: Event) => string | undefined,
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
      node.route = event.route as RouteValue;
    }
    for (const id of event.longRunningToolIds ?? []) {
      node.interruptIds.add(id);
      interruptOwner.set(id, key);
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
 * Builds a minimal completion result for a fast-forwarded (cached) node on
 * resume. Only the fields read by completion handling are populated; the node's
 * events are NOT re-emitted (they already exist in the session).
 */
export function makeFastForwardContext(
  parent: NodeContext,
  prior: RehydratedNode,
): NodeContext {
  return {
    output: prior.output,
    route: prior.route,
    branch: prior.branch ?? parent.branch,
    interruptIds: [],
  } as unknown as NodeContext;
}

/** Extracts the node name (leaf, without run id) from a dotted node path. */
export function nodeNameFromPath(path: string): string {
  const leaf = path.split(/[./]/).pop() ?? path;
  return leaf.split('@')[0];
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
