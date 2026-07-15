/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ParsedGraph} from './graph_parser.js';

/**
 * Performs structural validation on a ParsedGraph before execution begins.
 * Verifies reachability, checks for unintended cycles in DAG mode, and validates JoinNode upstream counts.
 *
 * @param graph The ParsedGraph to validate.
 * @param options Optional validation settings (e.g. `allowCycles`).
 * @throws Error if the graph structure is invalid or malformed.
 */
export function validateGraph(
  graph: ParsedGraph,
  options?: {allowCycles?: boolean},
): void {
  // 1. Reachability check from "START"
  const visited = new Set<string>(['START']);
  const queue: string[] = ['START'];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges = graph.adjacencyList.get(current) || [];
    for (const edge of edges) {
      if (!visited.has(edge.target.name)) {
        visited.add(edge.target.name);
        queue.push(edge.target.name);
      }
    }
  }

  for (const [nodeName] of graph.nodes) {
    if (!visited.has(nodeName)) {
      throw new Error(
        `Graph validation failed: Node "${nodeName}" is unreachable from "START". Check your edge definitions.`,
      );
    }
  }

  // 2. Cycle detection (DFS via recursion stack) if !allowCycles
  if (!options?.allowCycles) {
    const recursionStack = new Set<string>();
    const dfsVisited = new Set<string>();

    const checkCycles = (nodeName: string): void => {
      dfsVisited.add(nodeName);
      recursionStack.add(nodeName);

      const edges = graph.adjacencyList.get(nodeName) || [];
      for (const edge of edges) {
        const targetName = edge.target.name;
        if (!dfsVisited.has(targetName)) {
          checkCycles(targetName);
        } else if (recursionStack.has(targetName)) {
          throw new Error(
            `Graph validation failed: Cycle detected involving node "${targetName}". If your workflow intentionally contains loops, enable cycle support or use dynamic routing.`,
          );
        }
      }

      recursionStack.delete(nodeName);
    };

    checkCycles('START');
  }

  // 3. JoinNode upstream predecessor validation
  for (const [nodeName, node] of graph.nodes) {
    const nodeObj = node as unknown as Record<string, unknown>;
    if (
      'upstreamCount' in nodeObj &&
      typeof nodeObj.upstreamCount === 'number'
    ) {
      const upstreamCount = nodeObj.upstreamCount as number;
      const actualInbound = graph.inboundCounts.get(nodeName) || 0;
      if (upstreamCount < 1) {
        throw new Error(
          `JoinNode "${nodeName}" has invalid upstreamCount: ${upstreamCount}. Must be >= 1.`,
        );
      }
      if (upstreamCount > actualInbound) {
        throw new Error(
          `JoinNode "${nodeName}" expects ${upstreamCount} upstream predecessors, but only has ${actualInbound} inbound edges defined in the graph.`,
        );
      }
    }
  }
}
