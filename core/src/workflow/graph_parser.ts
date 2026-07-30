/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode} from './base_node.js';
import type {ChainElement, Edge, EdgeItem} from './graph.js';
import {node, NodeLike} from './node.js';

/** Expands one chain step into the nodes it covers. */
function flattenElement(element: ChainElement): NodeLike[] {
  return Array.isArray(element) ? element : [element];
}

/**
 * Resolves a chain entry to a node, reusing the node built for a given
 * function so the same function referenced twice becomes one graph node.
 */
function resolveNode(
  nodeLike: NodeLike,
  built: Map<NodeLike, BaseNode>,
): BaseNode {
  if (nodeLike instanceof BaseNode) {
    return nodeLike;
  }
  const existing = built.get(nodeLike);
  if (existing) {
    return existing;
  }
  const resolved = node(nodeLike);
  built.set(nodeLike, resolved);
  return resolved;
}

/**
 * Flattens a workflow's edge list into plain edges.
 *
 * A chain array creates an unrouted edge from every node of each step to every
 * node of the next step, so `[START, a, [b, c]]` fans `a` out to both `b` and
 * `c`. Explicit {@link Edge} objects pass through with their route intact.
 */
export function parseEdgeItems(items: readonly EdgeItem[]): Edge[] {
  const built = new Map<NodeLike, BaseNode>();
  const edges: Edge[] = [];

  for (const item of items) {
    if (!Array.isArray(item)) {
      // An explicit edge already names its nodes; copy it so later mutation of
      // the caller's object cannot reshape the graph.
      edges.push({
        fromNode: item.fromNode,
        toNode: item.toNode,
        route: item.route,
      });
      continue;
    }
    for (let i = 0; i < item.length - 1; i++) {
      for (const from of flattenElement(item[i])) {
        for (const to of flattenElement(item[i + 1])) {
          edges.push({
            fromNode: resolveNode(from, built),
            toNode: resolveNode(to, built),
          });
        }
      }
    }
  }

  return edges;
}
