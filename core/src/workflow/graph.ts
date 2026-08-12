/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseAgent} from '../agents/base_agent.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {BaseNode} from './base_node.js';
import {parseEdgeItems} from './utils/graph_parser.js';
import {validateGraph} from './utils/graph_validation.js';

/**
 * A unique symbol branding {@link Edge} instances.
 *
 * `isEdge` matches on this brand rather than `instanceof` so an edge built
 * by another copy of adk-js in the same runtime is still recognised (an
 * `instanceof` check fails across package copies) — mirroring the
 * `Symbol.for('google.adk.*')` brands used across ADK.
 */
const EDGE_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.edge');

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
 * What `ctx.runNode()` accepts: everything an edge accepts except the `'START'`
 * sentinel, which marks a graph entry point rather than something runnable.
 */
export type RunnableNode = Exclude<NodeLike, 'START'>;

/**
 * A mapping from route values to destination node(s). A value may be a single
 * node or an array of nodes (fan-out).
 *
 * @example
 *   {question: answerNode, statement: commentNode}
 *   {retry: [nodeA, nodeB]}   // fan-out: both triggered
 *
 * @remarks
 * JavaScript object keys are always strings, so a numeric key (`{2: node}`) and
 * a boolean key (`{true: node}`) are reconstructed to their typed
 * {@link RouteValue} (`2`, `true`) when parsed — mirroring Python dict keys.
 * Because of this, routes are matched **by string value**
 * ({@link Graph.getNextPendingNodes} compares `String(route)` on both sides), so
 * a node emitting `2` and one emitting `'2'` both fire a `{2: node}` edge. The
 * flip side is that a numeric/boolean-looking route and its string spelling
 * cannot be distinguished in a routing map; use distinct, non-ambiguous route
 * keys when that matters.
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
  /** Brand identifying this object as an {@link Edge} (see `isEdge`). */
  readonly [EDGE_SIGNATURE_SYMBOL] = true;

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
 * Type guard for {@link Edge}.
 *
 * Matches on the {@link EDGE_SIGNATURE_SYMBOL} brand rather than `instanceof` so
 * it stays correct across package copies (see the brand's doc).
 */
export function isEdge(value: unknown): value is Edge {
  return (
    typeof value === 'object' &&
    value !== null &&
    EDGE_SIGNATURE_SYMBOL in value &&
    value[EDGE_SIGNATURE_SYMBOL] === true
  );
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

  /** Terminal node names (no outgoing edges); populated by {@link validate}. */
  get terminalNodeNames(): ReadonlySet<string> {
    return this._terminalNodeNames;
  }

  /**
   * Determines the next nodes to transition to PENDING based on the route(s)
   * emitted by a completed node. Ported from Python `get_next_pending_nodes`.
   *
   * Logs at debug when the node emitted a route, has conditional outgoing
   * edges, and none of them (nor a `DEFAULT_ROUTE` edge) matched — the branch
   * stops there, which is easy to mistake for a bug. Behaviour is unchanged.
   */
  getNextPendingNodes(
    nodeName: string,
    routesToMatch: RouteValue | RouteValue[] | null | undefined,
  ): string[] {
    const nextPending: string[] = [];
    let matchedSpecificRoute = false;
    let defaultRouteNode: string | undefined;
    // Routes this node's conditional edges are keyed to, used only for the
    // unmatched-route warning below.
    const availableRoutes: string[] = [];

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

      // Match by string value: a JS routing-map key is always a string, so
      // `{2: n}`/`{'2': n}` are indistinguishable and are both normalized to the
      // number 2 by the parser. Comparing `String(...)` on both sides keeps a
      // node that emits `'2'` (or `'true'`) from silently missing its edge. See
      // the RoutingMap doc comment.
      const edgeRoutes = new Set<string>(
        (Array.isArray(edge.route) ? edge.route : [edge.route]).map(String),
      );
      availableRoutes.push(...edgeRoutes);

      let edgeMatched = false;
      if (Array.isArray(routesToMatch)) {
        edgeMatched = routesToMatch.some((r) => edgeRoutes.has(String(r)));
      } else if (routesToMatch !== null && routesToMatch !== undefined) {
        edgeMatched = edgeRoutes.has(String(routesToMatch));
      }

      if (edgeMatched) {
        nextPending.push(edge.toNode.name);
        matchedSpecificRoute = true;
      }
    }

    if (!matchedSpecificRoute && defaultRouteNode) {
      nextPending.push(defaultRouteNode);
    }

    if (nextPending.length === 0 && availableRoutes.length > 0) {
      const emitted =
        routesToMatch === null || routesToMatch === undefined
          ? []
          : Array.isArray(routesToMatch)
            ? routesToMatch
            : [routesToMatch];

      // A bare `false` against a `true` edge is the conditional-continue
      // idiom, where stopping IS the intent. Compared as a string, like every
      // other route match in this function, so `false` and `'false'` behave
      // alike; and only when a `true` edge exists, so `false` against an
      // unrelated route set is still reported.
      const isConditionalContinue =
        availableRoutes.includes('true') &&
        emitted.length > 0 &&
        emitted.every((r) => String(r) === 'false');

      if (emitted.length > 0 && !isConditionalContinue) {
        // Behaviour is unchanged, and still matches adk-python
        // (`_get_next_pending_nodes` returns an empty list here): the branch
        // simply stops.
        //
        // Logged at debug rather than warn: routing back on one value and
        // letting the other fall through is how the loop samples exit, so at
        // warn a correct graph would complain on every successful run. This
        // exists for the case it was written for — a run that produced nothing
        // and gave no clue why — which is exactly when debug logging goes on.
        const shown = emitted.map((r) => JSON.stringify(r)).join(', ');
        const known = [...new Set(availableRoutes)]
          .map((r) => JSON.stringify(r))
          .join(', ');
        logger.debug(
          `Node '${nodeName}' emitted route ${shown}, which matches no ` +
            `outgoing edge, so this branch stops here. Edges from this node ` +
            `are keyed to: ${known}.`,
        );
      }
    }

    return nextPending;
  }

  /** Validates the graph and computes terminal node names. */
  validate(): void {
    this._terminalNodeNames = validateGraph(this.nodes, this.edges);
  }
}

/**
 * Builds, validates, and returns a {@link Graph} from a list of edge items.
 *
 * Validation runs here (not opt-in) so structural problems a graph can only
 * have at build time — unreachable nodes, duplicate names/edges, routed edges
 * from START, unconditional cycles — fail loudly at construction rather than
 * surfacing as silent mis-routing at run time. It also populates the graph's
 * {@link Graph.terminalNodeNames}, which is otherwise empty.
 */
export function createGraphFromEdgeItems(edgeItems: EdgeItem[]): Graph {
  const graph = new Graph(parseEdgeItems(edgeItems));
  graph.validate();
  return graph;
}
