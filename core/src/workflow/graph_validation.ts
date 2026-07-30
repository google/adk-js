/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode, START} from './base_node.js';
import type {Edge} from './graph.js';
import {DEFAULT_ROUTE} from './route.js';

const PREFIX = 'Graph validation failed.';

function fail(message: string): never {
  throw new Error(`${PREFIX} ${message}`);
}

/** Every node name must be unique, so a name identifies exactly one node. */
function validateDuplicateNodeNames(nodes: readonly BaseNode[]): Set<string> {
  const names = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) {
      duplicates.add(node.name);
    }
    names.add(node.name);
  }
  if (duplicates.size > 0) {
    fail(
      `Duplicate node names found: ${[...duplicates].sort().join(', ')}. This` +
        ' means multiple distinct node objects have the same name. If you' +
        ' intended to reuse the same node, pass the exact same object' +
        ' instance; otherwise give them unique names.',
    );
  }
  return names;
}

function validateStartNode(nodeNames: ReadonlySet<string>): void {
  if (!nodeNames.has(START.name)) {
    fail(`START node (name: '${START.name}') not found in graph nodes.`);
  }
}

function validateStartEdges(edges: readonly Edge[]): void {
  for (const edge of edges) {
    if (edge.fromNode.name === START.name && edge.route !== undefined) {
      fail(
        `Edges from START must not have routes (edge to ${edge.toNode.name}` +
          ` has route ${JSON.stringify(edge.route)}).`,
      );
    }
  }
}

/**
 * Maps each source node name to the names it has edges to.
 *
 * @param unroutedOnly Only follow edges that carry no route.
 */
function successorsOf(
  edges: readonly Edge[],
  unroutedOnly = false,
): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    if (unroutedOnly && edge.route !== undefined) {
      continue;
    }
    const fromName = edge.fromNode.name;
    const existing = successors.get(fromName);
    if (existing) {
      existing.push(edge.toNode.name);
    } else {
      successors.set(fromName, [edge.toNode.name]);
    }
  }
  return successors;
}

/** Every node must be reachable from START, and START must be the entry. */
function validateConnectivity(
  edges: readonly Edge[],
  nodeNames: ReadonlySet<string>,
): void {
  const successors = successorsOf(edges);

  const reachable = new Set<string>();
  const stack = [START.name];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (reachable.has(name)) {
      continue;
    }
    reachable.add(name);
    stack.push(...(successors.get(name) ?? []));
  }

  const unreachable = [...nodeNames].filter((name) => !reachable.has(name));
  if (unreachable.length > 0) {
    fail(
      'The following nodes are unreachable from START: ' +
        unreachable.sort().join(', '),
    );
  }
  if (edges.some((edge) => edge.toNode.name === START.name)) {
    fail('START node must not have incoming edges.');
  }
}

function validateDuplicateEdges(edges: readonly Edge[]): void {
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.fromNode.name}\u0000${edge.toNode.name}`;
    if (seen.has(key)) {
      fail(
        `Duplicate edge found: from=${edge.fromNode.name},` +
          ` to=${edge.toNode.name}`,
      );
    }
    seen.add(key);
  }
}

/** `DEFAULT_ROUTE` is a standalone fallback: one per source, never in a list. */
function validateDefaultRoutes(edges: readonly Edge[]): void {
  const defaultTargets = new Map<string, string>();
  for (const edge of edges) {
    if (Array.isArray(edge.route) && edge.route.includes(DEFAULT_ROUTE)) {
      fail(
        'DEFAULT_ROUTE cannot be combined with other routes in a list (edge' +
          ` from=${edge.fromNode.name}, to=${edge.toNode.name}). Use a` +
          ' separate edge for DEFAULT_ROUTE.',
      );
    }
    if (edge.route !== DEFAULT_ROUTE) {
      continue;
    }
    const existing = defaultTargets.get(edge.fromNode.name);
    if (existing !== undefined) {
      fail(
        `Multiple DEFAULT_ROUTE edges found from node ${edge.fromNode.name}` +
          ` to ${existing} and ${edge.toNode.name}`,
      );
    }
    defaultTargets.set(edge.fromNode.name, edge.toNode.name);
  }
}

/**
 * Walks `name`'s successors depth first, failing if the walk re-enters a node
 * still on `path`. `done` holds the nodes already fully explored.
 */
function walkForCycle(
  name: string,
  successors: ReadonlyMap<string, string[]>,
  done: Set<string>,
  path: string[],
): void {
  path.push(name);
  for (const next of successors.get(name) ?? []) {
    const cycleStart = path.indexOf(next);
    if (cycleStart !== -1) {
      const cycle = [...path.slice(cycleStart), next];
      fail(
        `Unconditional cycle detected: ${cycle.join(' -> ')}. Cycles must` +
          ' include at least one conditional (routed) edge to avoid' +
          ' infinite loops.',
      );
    }
    if (!done.has(next)) {
      walkForCycle(next, successors, done, path);
    }
  }
  path.pop();
  done.add(name);
}

/**
 * A cycle made only of unrouted edges can never exit, so it would loop
 * forever. A cycle needs at least one routed edge to be able to break out.
 */
function detectUnconditionalCycles(
  edges: readonly Edge[],
  nodeNames: ReadonlySet<string>,
): void {
  const successors = successorsOf(edges, true);
  const done = new Set<string>();
  for (const name of nodeNames) {
    if (!done.has(name)) {
      walkForCycle(name, successors, done, []);
    }
  }
}

/**
 * Checks that a graph is runnable.
 *
 * A graph with no nodes is trivially valid: an empty workflow runs and
 * produces nothing.
 *
 * @throws If any structural rule is violated. Every message starts with
 *     `Graph validation failed.`.
 */
export function validateGraph(
  nodes: readonly BaseNode[],
  edges: readonly Edge[],
): void {
  if (nodes.length === 0) {
    return;
  }
  const nodeNames = validateDuplicateNodeNames(nodes);
  validateStartNode(nodeNames);
  validateStartEdges(edges);
  validateConnectivity(edges, nodeNames);
  validateDuplicateEdges(edges);
  validateDefaultRoutes(edges);
  detectUnconditionalCycles(edges, nodeNames);
}
