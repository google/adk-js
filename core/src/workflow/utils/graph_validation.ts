/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validates workflow graphs and computes terminal nodes.
 *
 * Ported from `google/adk-python` `workflow/utils/_graph_validation.py`.
 * The Phase 3 static-schema check and the Phase 7 chat-agent wiring check are
 * intentionally deferred to their respective phases.
 */

import {BaseNode, START} from '../base_node.js';
import {DEFAULT_ROUTE, Edge} from '../graph.js';

function validateDuplicateNodeNames(nodes: BaseNode[]): Set<string> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([name]) => name)
    .sort();
  if (duplicates.length > 0) {
    throw new Error(
      `Graph validation failed. Duplicate node names found: ${JSON.stringify(
        duplicates,
      )}. Pass the exact same object instance to reuse a node, or give distinct nodes unique names.`,
    );
  }
  return new Set(counts.keys());
}

function validateStartNode(nodeNames: Set<string>): void {
  if (!nodeNames.has(START.name)) {
    throw new Error(
      `Graph validation failed. START node (name: '${START.name}') not found in graph nodes.`,
    );
  }
}

function validateStartEdges(edges: Edge[]): void {
  for (const edge of edges) {
    if (edge.fromNode.name === START.name && edge.route !== null) {
      throw new Error(
        `Graph validation failed. Edges from START must not have routes (edge to ${edge.toNode.name} has route ${String(
          edge.route,
        )}).`,
      );
    }
  }
}

function validateConnectivity(edges: Edge[], nodeNames: Set<string>): void {
  const adj = new Map<string, Set<string>>();
  for (const name of nodeNames) {
    adj.set(name, new Set());
  }
  const toNodes = new Set<string>();
  for (const edge of edges) {
    adj.get(edge.fromNode.name)!.add(edge.toNode.name);
    toNodes.add(edge.toNode.name);
  }

  const reachable = new Set<string>();
  const stack = [START.name];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (reachable.has(node)) {
      continue;
    }
    reachable.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!reachable.has(next)) {
        stack.push(next);
      }
    }
  }

  const unreachable = [...nodeNames].filter((n) => !reachable.has(n)).sort();
  if (unreachable.length > 0) {
    throw new Error(
      `Graph validation failed. The following nodes are unreachable from START: ${JSON.stringify(
        unreachable,
      )}`,
    );
  }
  if (toNodes.has(START.name)) {
    throw new Error(
      'Graph validation failed. START node must not have incoming edges.',
    );
  }
}

/**
 * Rejects an edge that repeats a `(from, to, route)` triple already in the
 * graph — the case where one emitted route would trigger the same target twice.
 *
 * The route is part of the identity, not just the pair of endpoints: two route
 * keys sharing a destination (`[router, {approve: shared, escalate: shared}]`)
 * are distinct edges that {@link Graph.getNextPendingNodes} already matches
 * independently, and keying on the endpoints alone rejected the obvious way to
 * point two decisions at one reusable sub-workflow.
 *
 * A multi-route edge is checked per route value, since it is the route that
 * fires an edge, so `route: ['a', 'b']` and `route: 'b'` to the same target
 * still collide on `'b'`. Route values are compared as strings, matching how
 * `getNextPendingNodes` matches them, so `2` and `'2'` are the same route here
 * too. An unconditional edge (`route: null`) is its own identity and never
 * collides with a routed one.
 */
function validateDuplicateEdges(edges: Edge[]): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    const unconditional = edge.route === null || edge.route === undefined;
    const routes = unconditional
      ? [null]
      : (Array.isArray(edge.route) ? edge.route : [edge.route]).map(String);
    for (const route of routes) {
      // JSON so an unconditional edge (`null`) cannot collide with an edge
      // routed on the literal string "null".
      const key = JSON.stringify([edge.fromNode.name, edge.toNode.name, route]);
      if (seen.has(key)) {
        throw new Error(
          `Graph validation failed. Duplicate edge found: from=${
            edge.fromNode.name
          }, to=${edge.toNode.name}${
            unconditional ? '' : `, route=${JSON.stringify(route)}`
          }. ${
            unconditional
              ? 'The same pair is already connected unconditionally'
              : 'That route already points at this node'
          }, so the target would be triggered twice.`,
        );
      }
      seen.add(key);
    }
  }
}

function validateDefaultRoutes(edges: Edge[]): void {
  const defaultRouteEdges = new Map<string, string>();
  for (const edge of edges) {
    if (Array.isArray(edge.route) && edge.route.includes(DEFAULT_ROUTE)) {
      throw new Error(
        `Graph validation failed. DEFAULT_ROUTE cannot be combined with other routes in a list (edge from=${edge.fromNode.name}, to=${edge.toNode.name}). Use a separate edge for DEFAULT_ROUTE.`,
      );
    }
    if (edge.route === DEFAULT_ROUTE) {
      const from = edge.fromNode.name;
      if (defaultRouteEdges.has(from)) {
        throw new Error(
          `Graph validation failed. Multiple DEFAULT_ROUTE edges found from node ${from} to ${defaultRouteEdges.get(
            from,
          )} and ${edge.toNode.name}`,
        );
      }
      defaultRouteEdges.set(from, edge.toNode.name);
    }
  }
}

function detectUnconditionalCycles(
  edges: Edge[],
  nodeNames: Set<string>,
): void {
  const adj = new Map<string, string[]>();
  for (const name of nodeNames) {
    adj.set(name, []);
  }
  for (const edge of edges) {
    if (edge.route === null) {
      adj.get(edge.fromNode.name)!.push(edge.toNode.name);
    }
  }

  const inStack = new Set<string>();
  const done = new Set<string>();

  const dfs = (node: string, path: string[]): void => {
    inStack.add(node);
    path.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      if (inStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        const cycle = [...path.slice(cycleStart), neighbor];
        throw new Error(
          `Graph validation failed. Unconditional cycle detected: ${cycle.join(
            ' -> ',
          )}. An unconditional cycle has no exit and would loop forever; break it with at least one conditional (routed) edge so a node can leave the cycle by not emitting that route. (A routed cycle can still loop if a node keeps emitting the route — bounding that is the node's responsibility, not this validator's.)`,
        );
      }
      if (!done.has(neighbor)) {
        dfs(neighbor, path);
      }
    }
    path.pop();
    inStack.delete(node);
    done.add(node);
  };

  for (const name of nodeNames) {
    if (!done.has(name)) {
      dfs(name, []);
    }
  }
}

function computeTerminalNodes(nodes: BaseNode[], edges: Edge[]): Set<string> {
  const fromNames = new Set(edges.map((e) => e.fromNode.name));
  return new Set(
    nodes
      .filter((n) => n.name !== START.name && !fromNames.has(n.name))
      .map((n) => n.name),
  );
}

/**
 * Validates the workflow graph and returns the set of terminal node names.
 */
export function validateGraph(nodes: BaseNode[], edges: Edge[]): Set<string> {
  const nodeNames = validateDuplicateNodeNames(nodes);
  validateStartNode(nodeNames);
  validateStartEdges(edges);
  validateConnectivity(edges, nodeNames);
  validateDuplicateEdges(edges);
  validateDefaultRoutes(edges);
  detectUnconditionalCycles(edges, nodeNames);
  return computeTerminalNodes(nodes, edges);
}
