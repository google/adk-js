/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parses workflow edge items and chains into a flat list of {@link Edge}s.
 *
 * Ported from `google/adk-python` `workflow/utils/_graph_parser.py`.
 */

import {BaseNode} from '../base_node.js';
import {
  ChainElement,
  Edge,
  EdgeItem,
  isEdge,
  NodeLike,
  RouteValue,
  RoutingMap,
} from '../graph.js';
import {buildNode, isNodeLike, isPlainObject} from './workflow_graph_utils.js';

/**
 * Normalizes a routing-map key back to its typed {@link RouteValue}. JS object
 * keys are always strings, so integer route keys arrive as numeric strings and
 * boolean route keys as `'true'`/`'false'`. Reconstructing the typed value lets
 * a node emitting `2` or `true` match `{2: ...}` / `{true: ...}` (mirroring
 * Python dict keys `2` / `True`).
 */
function normalizeRouteKey(routeKey: string): RouteValue {
  if (/^-?\d+$/.test(routeKey)) {
    return Number(routeKey);
  }
  if (routeKey === 'true' || routeKey === 'false') {
    return routeKey === 'true';
  }
  return routeKey;
}

/** Expands a routing map into individual (from, to, route) triples. */
function expandRoutingMap(
  fromElement: ChainElement,
  routingMap: RoutingMap,
): Array<[ChainElement, NodeLike | readonly NodeLike[], RouteValue]> {
  const keys = Object.keys(routingMap);
  if (keys.length === 0) {
    throw new Error(
      'Routing map must not be empty. Provide at least one route -> node mapping.',
    );
  }

  const expanded: Array<
    [ChainElement, NodeLike | readonly NodeLike[], RouteValue]
  > = [];
  for (const routeKey of keys) {
    const normalizedKey: RouteValue = normalizeRouteKey(routeKey);
    const target = routingMap[routeKey];
    if (Array.isArray(target)) {
      for (const node of target) {
        if (!isNodeLike(node)) {
          throw new Error(
            `Invalid node in fan-out tuple for route ${String(routeKey)}.`,
          );
        }
      }
    } else if (!isNodeLike(target)) {
      throw new Error(
        `Invalid routing map value for route ${String(routeKey)}.`,
      );
    }
    // `normalizeRouteKey` returns `string | number | boolean` by construction,
    // which is exactly `RouteValue`, so no further validation of the key is
    // needed here.
    expanded.push([
      fromElement,
      target as NodeLike | readonly NodeLike[],
      normalizedKey,
    ]);
  }
  return expanded;
}

/** Extracts all target nodes from a routing map, flattening fan-out arrays. */
function nodesFromRoutingMap(routingMap: RoutingMap): NodeLike[] {
  const nodes: NodeLike[] = [];
  for (const target of Object.values(routingMap)) {
    if (Array.isArray(target)) {
      nodes.push(...(target as NodeLike[]));
    } else {
      nodes.push(target as NodeLike);
    }
  }
  return nodes;
}

/** Flattens a chain element into a list of individual nodes. */
function flattenElement(element: ChainElement): NodeLike[] {
  if (isPlainObject(element)) {
    return nodesFromRoutingMap(element as RoutingMap);
  }
  if (Array.isArray(element)) {
    return [...(element as readonly NodeLike[])];
  }
  return [element as NodeLike];
}

/** Gets a node from the identity map or builds (and caches) it. */
function getOrBuildNode(
  nodeLike: NodeLike,
  nodeMap: Map<object, BaseNode>,
): BaseNode {
  if (nodeLike === 'START') {
    return buildNode('START');
  }
  if (typeof nodeLike === 'object' || typeof nodeLike === 'function') {
    const cached = nodeMap.get(nodeLike as object);
    if (cached) {
      return cached;
    }
    const built = buildNode(nodeLike);
    // Only cache when a distinct wrapper was produced (or always, to preserve
    // identity across repeated references within the same parse).
    nodeMap.set(nodeLike as object, built);
    return built;
  }
  return buildNode(nodeLike);
}

/** Shared accumulator threaded through the edge-processing helpers. */
interface ParseContext {
  /** Cache mapping a source node-like to the {@link BaseNode} built for it. */
  nodeMap: Map<object, BaseNode>;
  /** Accumulator the produced edges are pushed into. */
  out: Edge[];
}

function processExplicitEdge({
  edge,
  nodeMap,
  out,
}: ParseContext & {edge: Edge}): void {
  out.push(
    new Edge(
      getOrBuildNode(edge.fromNode, nodeMap),
      getOrBuildNode(edge.toNode, nodeMap),
      edge.route,
    ),
  );
}

function processRoutingMapEdge({
  fromEl,
  toEl,
  nodeMap,
  out,
}: ParseContext & {fromEl: ChainElement; toEl: RoutingMap}): void {
  if (isPlainObject(fromEl)) {
    throw new Error(
      'Consecutive routing maps are not allowed in a chain. Split them into separate edge items.',
    );
  }
  for (const [expFrom, expTo, route] of expandRoutingMap(fromEl, toEl)) {
    for (const fromNode of flattenElement(expFrom)) {
      for (const toNode of flattenElement(expTo as ChainElement)) {
        out.push(
          new Edge(
            getOrBuildNode(fromNode, nodeMap),
            getOrBuildNode(toNode, nodeMap),
            route,
          ),
        );
      }
    }
  }
}

function processUnconditionalEdge({
  fromEl,
  toEl,
  nodeMap,
  out,
}: ParseContext & {fromEl: ChainElement; toEl: ChainElement}): void {
  for (const fromNode of flattenElement(fromEl)) {
    for (const toNode of flattenElement(toEl)) {
      out.push(
        new Edge(
          getOrBuildNode(fromNode, nodeMap),
          getOrBuildNode(toNode, nodeMap),
          null,
        ),
      );
    }
  }
}

function processChain({
  chain,
  nodeMap,
  out,
}: ParseContext & {chain: ChainElement[]}): void {
  for (let i = 0; i < chain.length - 1; i++) {
    const fromEl = chain[i];
    const toEl = chain[i + 1];
    if (isPlainObject(toEl)) {
      processRoutingMapEdge({fromEl, toEl: toEl as RoutingMap, nodeMap, out});
    } else {
      processUnconditionalEdge({fromEl, toEl, nodeMap, out});
    }
  }
}

/** Parses a list of edge items into a flat list of {@link Edge} objects. */
export function parseEdgeItems(edgeItems: EdgeItem[]): Edge[] {
  const nodeMap = new Map<object, BaseNode>();
  const out: Edge[] = [];

  for (const item of edgeItems) {
    if (isEdge(item)) {
      processExplicitEdge({edge: item, nodeMap, out});
    } else if (Array.isArray(item)) {
      processChain({chain: item, nodeMap, out});
    } else {
      throw new Error(`Invalid edge item type: ${typeof item}`);
    }
  }

  return out;
}
