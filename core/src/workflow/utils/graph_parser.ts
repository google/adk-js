/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseNode} from '../base_node.js';
import {Trigger} from '../trigger.js';

/**
 * A single element inside a GraphEdge array.
 */
export type EdgeElement =
  | string // e.g., "START"
  | BaseNode // concrete node instance
  | Record<string | symbol, BaseNode> // route map: { ROUTE_A: nodeA, ROUTE_B: nodeB }
  | [Trigger, BaseNode] // conditional tuple: [trigger, targetNode]
  | BaseNode[] // fan-out node array: [nodeA, nodeB]
  | readonly BaseNode[]; // fan-out node array

/**
 * A workflow graph edge definition.
 * Examples:
 *   ["START", nodeA, nodeB, nodeC]
 *   ["START", [nodeA, nodeB], joinNode]
 *   [routerNode, { ROUTE_X: nodeC, ROUTE_Y: nodeD }]
 *   [nodeA, [Trigger.fromPredicate(...), nodeB]]
 */
export type GraphEdge = EdgeElement[];

/**
 * Internal representation of a directed edge between two nodes.
 */
export interface AdjacencyEdge {
  readonly source: string; // source node name or "START"
  readonly target: BaseNode;
  readonly trigger?: Trigger;
}

/**
 * A parsed and structured workflow graph ready for execution or validation.
 */
export class ParsedGraph {
  readonly nodes = new Map<string, BaseNode>();
  readonly adjacencyList = new Map<string, AdjacencyEdge[]>();
  readonly inboundCounts = new Map<string, number>();

  constructor() {
    this.adjacencyList.set('START', []);
    this.inboundCounts.set('START', 0);
  }

  /**
   * Registers a node in the graph and initializes its adjacency and inbound counters if new.
   * @param node The node to add.
   */
  addNode(node: BaseNode): void {
    if (!this.nodes.has(node.name)) {
      this.nodes.set(node.name, node);
      this.adjacencyList.set(node.name, []);
      this.inboundCounts.set(node.name, 0);
    }
  }

  /**
   * Adds a directed edge from `source` to `target` with an optional `trigger`.
   * @param source Source node name (or "START").
   * @param target Target node instance.
   * @param trigger Optional trigger condition.
   */
  addEdge(source: string, target: BaseNode, trigger?: Trigger): void {
    this.addNode(target);
    if (source !== 'START' && !this.nodes.has(source)) {
      throw new Error(
        `Source node "${source}" must be added to the graph or referenced before defining an edge from it.`,
      );
    }

    const edges = this.adjacencyList.get(source) || [];
    edges.push({source, target, trigger});
    this.adjacencyList.set(source, edges);

    const currentInbound = this.inboundCounts.get(target.name) || 0;
    this.inboundCounts.set(target.name, currentInbound + 1);
  }
}

/**
 * Parses an array of user-defined GraphEdge structures into an internal ParsedGraph.
 * @param edges Array of GraphEdge sequences or branch definitions.
 * @returns A structured ParsedGraph.
 */
export function parseGraph(edges: GraphEdge[]): ParsedGraph {
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error(
      'parseGraph requires a non-empty array of GraphEdge definitions.',
    );
  }

  const graph = new ParsedGraph();

  for (const edgeSeq of edges) {
    if (!Array.isArray(edgeSeq) || edgeSeq.length < 2) {
      throw new Error(
        'Each GraphEdge definition must be an array with at least 2 elements (e.g., ["START", nodeA]).',
      );
    }

    for (let i = 0; i < edgeSeq.length - 1; i++) {
      const current = edgeSeq[i];
      const next = edgeSeq[i + 1];

      const sources = flattenSource(current, graph, i);
      for (const sourceName of sources) {
        if (isBaseNode(next)) {
          graph.addEdge(sourceName, next);
        } else if (Array.isArray(next) && !isTriggerTuple(next)) {
          for (const targetNode of next) {
            if (!isBaseNode(targetNode)) {
              throw new Error(
                `All elements in target fan-out array from source "${sourceName}" must be BaseNode instances.`,
              );
            }
            graph.addEdge(sourceName, targetNode);
          }
        } else if (isRouteMap(next)) {
          const entries: [string | symbol, BaseNode][] = [
            ...Object.entries(next),
            ...Object.getOwnPropertySymbols(next).map(
              (sym) =>
                [sym, (next as Record<symbol, BaseNode>)[sym]] as [
                  string | symbol,
                  BaseNode,
                ],
            ),
          ];
          for (const [routeKey, targetNode] of entries) {
            if (!isBaseNode(targetNode)) {
              throw new Error(
                `Target for route "${String(routeKey)}" from source "${sourceName}" must be a BaseNode instance.`,
              );
            }
            graph.addEdge(sourceName, targetNode, Trigger.fromRoute(routeKey));
          }
        } else if (isTriggerTuple(next)) {
          const [trigger, targetNode] = next;
          graph.addEdge(sourceName, targetNode, trigger);
        } else {
          throw new Error(
            `Invalid target element at index ${i + 1} from source "${sourceName}". Must be a BaseNode, BaseNode array, route dictionary, or [Trigger, BaseNode] tuple.`,
          );
        }
      }
    }
  }

  for (const [nodeName, node] of graph.nodes.entries()) {
    if (
      node &&
      node.constructor &&
      node.constructor.name === 'JoinNode' &&
      (node as unknown as {upstreamCount: number}).upstreamCount === 0
    ) {
      const count = graph.inboundCounts.get(nodeName) || 0;
      if (count >= 1) {
        (node as unknown as {upstreamCount: number}).upstreamCount = count;
      }
    }
  }

  return graph;
}

function flattenSource(
  element: EdgeElement,
  graph: ParsedGraph,
  index: number,
): string[] {
  if (typeof element === 'string' && element === 'START') {
    return ['START'];
  }
  if (isBaseNode(element)) {
    graph.addNode(element);
    return [element.name];
  }
  if (Array.isArray(element) && !isTriggerTuple(element)) {
    return element.map((node, idx) => {
      if (!isBaseNode(node)) {
        throw new Error(
          `Invalid source element inside array at index ${index}[${idx}]. Must be a BaseNode instance.`,
        );
      }
      graph.addNode(node);
      return node.name;
    });
  }
  throw new Error(
    `Invalid source element at index ${index} in edge sequence. Must be "START", a BaseNode, or an array of BaseNode instances.`,
  );
}

function isBaseNode(obj: unknown): obj is BaseNode {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    typeof (obj as BaseNode).name === 'string' &&
    'run' in obj &&
    typeof (obj as BaseNode).run === 'function'
  );
}

function isRouteMap(obj: unknown): obj is Record<string, BaseNode> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    !isBaseNode(obj) &&
    !Array.isArray(obj)
  );
}

function isTriggerTuple(obj: unknown): obj is [Trigger, BaseNode] {
  return (
    Array.isArray(obj) &&
    obj.length === 2 &&
    obj[0] instanceof Trigger &&
    isBaseNode(obj[1])
  );
}
