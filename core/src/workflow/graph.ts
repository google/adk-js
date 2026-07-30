/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

import {BaseNode} from './base_node.js';
import {parseEdgeItems} from './graph_parser.js';
import {validateGraph} from './graph_validation.js';
import {NodeLike} from './node.js';
import {DEFAULT_ROUTE, RouteValue, toRouteList} from './route.js';

/**
 * A directed edge between two workflow nodes.
 *
 * An edge with no `route` is always followed. An edge with a `route` is
 * followed when the source node emits a matching route, and an edge routed
 * with {@link DEFAULT_ROUTE} is followed when no other routed edge matched.
 */
export interface Edge {
  /** The node the edge starts at. */
  fromNode: BaseNode;

  /** The node the edge leads to. */
  toNode: BaseNode;

  /** The route(s) this edge is followed on. */
  route?: RouteValue | RouteValue[];
}

/**
 * One step of a chain: a single node, or several nodes to fan out to.
 */
export type ChainElement = NodeLike | NodeLike[];

/**
 * An entry in a workflow's edge list: an explicit {@link Edge}, or a chain
 * array such as `[START, a, [b, c], d]` that expands into unrouted edges.
 */
export type EdgeItem = Edge | ChainElement[];

/**
 * A workflow graph: a set of edges plus the nodes they connect.
 */
export class Graph {
  /**
   * The nodes of the graph, derived from the edges: deduplicated by object
   * identity and in first-seen order.
   */
  readonly nodes: readonly BaseNode[];

  /** The edges of the graph. */
  readonly edges: readonly Edge[];

  /**
   * The names of the nodes with no outgoing edge — where a branch of the
   * workflow ends. `START` is never among them: a valid graph always has at
   * least one edge out of it.
   */
  readonly terminalNodeNames: ReadonlySet<string>;

  constructor(edges: readonly Edge[]) {
    this.edges = edges;
    const nodes = new Set<BaseNode>();
    const sourceNames = new Set<string>();
    for (const edge of edges) {
      nodes.add(edge.fromNode);
      nodes.add(edge.toNode);
      sourceNames.add(edge.fromNode.name);
    }
    this.nodes = [...nodes];
    this.terminalNodeNames = new Set(
      this.nodes.filter((n) => !sourceNames.has(n.name)).map((n) => n.name),
    );
  }

  /** Builds a graph from a workflow's edge list, expanding any chains. */
  static fromEdgeItems(items: readonly EdgeItem[]): Graph {
    return new Graph(parseEdgeItems(items));
  }

  /**
   * Returns the nodes to run next after `nodeName` completed emitting
   * `routesToMatch`.
   *
   * @param nodeName The name of the node that just completed.
   * @param routesToMatch The route(s) it emitted, if any.
   */
  getNextPendingNodes(
    nodeName: string,
    routesToMatch?: RouteValue | RouteValue[],
  ): BaseNode[] {
    const emitted = toRouteList(routesToMatch);
    const next: BaseNode[] = [];
    let matchedSpecificRoute = false;
    let defaultRouteNode: BaseNode | undefined;
    let hasRoutedEdges = false;

    for (const edge of this.edges) {
      if (edge.fromNode.name !== nodeName) {
        continue;
      }
      if (edge.route === undefined) {
        next.push(edge.toNode);
        continue;
      }
      hasRoutedEdges = true;
      if (edge.route === DEFAULT_ROUTE) {
        defaultRouteNode = edge.toNode;
        continue;
      }
      const edgeRoutes = toRouteList(edge.route);
      if (edgeRoutes.some((route) => emitted.includes(route))) {
        next.push(edge.toNode);
        matchedSpecificRoute = true;
      }
    }

    if (!matchedSpecificRoute && defaultRouteNode) {
      next.push(defaultRouteNode);
    }
    if (hasRoutedEdges && next.length === 0) {
      logger.warn(
        `Node '${nodeName}' has conditional/DEFAULT edges but none were ` +
          `matched by the emitted route(s): ${JSON.stringify(routesToMatch)}. ` +
          'The branch will end.',
      );
    }
    return next;
  }

  /**
   * Checks the graph is runnable.
   *
   * @throws If the graph violates any structural rule; the message always
   *     starts with `Graph validation failed.`.
   */
  validate(): void {
    validateGraph(this.nodes, this.edges);
  }
}
