/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseAgent} from '../agents/base_agent.js';
import {BaseTool} from '../tools/base_tool.js';
import {BaseNode} from './base_node.js';
import {parseEdgeItems} from './utils/graph_parser.js';
import {validateGraph} from './utils/graph_validation.js';

/** Valid routing values used in conditional graph edges. */
export type RouteValue = boolean | number | string;

/** The fallback route key used when no specific route matches. */
export const DEFAULT_ROUTE = '__DEFAULT__';

/**
 * Any value that can be converted to a workflow node: a node, a tool, a plain
 * function, or the `'START'` sentinel literal. (Agent wrapping is added in
 * Phase 3 via `build_node`.)
 */
export type NodeLike =
  | BaseNode
  | BaseAgent
  | BaseTool
  | ((...args: never[]) => unknown)
  | 'START';

/**
 * A mapping from route values to destination node(s). A value may be a single
 * node or an array of nodes (fan-out).
 *
 * @example
 *   {question: answerNode, statement: commentNode}
 *   {retry: [nodeA, nodeB]}   // fan-out: both triggered
 */
export type RoutingMap = Record<
  string | number,
  NodeLike | readonly NodeLike[]
>;

/** An element within a workflow chain. */
export type ChainElement = NodeLike | readonly NodeLike[] | RoutingMap;

/**
 * An item that can be parsed into workflow edges: an explicit {@link Edge}, or a
 * chain expressed as an array of {@link ChainElement}s (e.g.
 * `['START', nodeA, nodeB]`).
 */
export type EdgeItem = Edge | ChainElement[];

/**
 * A directed edge in the workflow graph.
 *
 * Mirrors `google/adk-python` `workflow/_graph.py::Edge`.
 */
export class Edge {
  constructor(
    readonly fromNode: BaseNode,
    readonly toNode: BaseNode,
    /**
     * The route(s) this edge is associated with. `null` means unconditional
     * (always triggered). A single value or a list; the edge fires when the
     * emitted route matches any listed value.
     */
    readonly route: RouteValue | RouteValue[] | null = null,
  ) {}
}

/**
 * A compiled workflow graph. Nodes are inferred (deduped by identity) from the
 * edges.
 *
 * Mirrors `google/adk-python` `workflow/_graph.py::Graph`.
 */
export class Graph {
  readonly nodes: BaseNode[];
  readonly edges: Edge[];
  private _terminalNodeNames: ReadonlySet<string> = new Set();

  constructor(edges: Edge[]) {
    this.edges = edges;
    const seen = new Set<BaseNode>();
    const nodes: BaseNode[] = [];
    for (const edge of edges) {
      for (const node of [edge.fromNode, edge.toNode]) {
        if (!seen.has(node)) {
          seen.add(node);
          nodes.push(node);
        }
      }
    }
    this.nodes = nodes;
  }

  /** Builds and returns a graph from a list of edge items. */
  static fromEdgeItems(edgeItems: EdgeItem[]): Graph {
    return new Graph(parseEdgeItems(edgeItems));
  }

  /** Terminal node names (no outgoing edges); populated by {@link validate}. */
  get terminalNodeNames(): ReadonlySet<string> {
    return this._terminalNodeNames;
  }

  /**
   * Determines the next nodes to transition to PENDING based on the route(s)
   * emitted by a completed node. Ported from Python `get_next_pending_nodes`.
   */
  getNextPendingNodes(
    nodeName: string,
    routesToMatch: RouteValue | RouteValue[] | null | undefined,
  ): string[] {
    const nextPending: string[] = [];
    let matchedSpecificRoute = false;
    let defaultRouteNode: string | undefined;

    for (const edge of this.edges) {
      if (edge.fromNode.name !== nodeName) {
        continue;
      }
      if (edge.route === null || edge.route === undefined) {
        // Unconditional edges always fire.
        nextPending.push(edge.toNode.name);
        continue;
      }

      if (edge.route === DEFAULT_ROUTE) {
        defaultRouteNode = edge.toNode.name;
        continue;
      }

      const edgeRoutes = new Set<RouteValue>(
        Array.isArray(edge.route) ? edge.route : [edge.route],
      );

      let edgeMatched = false;
      if (Array.isArray(routesToMatch)) {
        edgeMatched = routesToMatch.some((r) => edgeRoutes.has(r));
      } else if (routesToMatch !== null && routesToMatch !== undefined) {
        edgeMatched = edgeRoutes.has(routesToMatch);
      }

      if (edgeMatched) {
        nextPending.push(edge.toNode.name);
        matchedSpecificRoute = true;
      }
    }

    if (!matchedSpecificRoute && defaultRouteNode) {
      nextPending.push(defaultRouteNode);
    }

    return nextPending;
  }

  /** Validates the graph and computes terminal node names. */
  validate(): void {
    this._terminalNodeNames = validateGraph(this.nodes, this.edges);
  }
}
