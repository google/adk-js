/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A value a node emits to select which of its outgoing graph edges are
 * followed.
 *
 * A node emits a route by assigning `ctx.route` while it runs. Matching is by
 * strict equality, so the emitted value and the value declared on the edge must
 * have the same type.
 */
export type RouteValue = string | number | boolean;

/**
 * The route of the fallback edge out of a node.
 *
 * An edge declaring this route is followed only when none of the node's other
 * routed edges matched. At most one such edge per source node is allowed.
 */
export const DEFAULT_ROUTE = '__DEFAULT__';

/** Normalizes a single route, a list of routes or nothing into a list. */
export function toRouteList(
  route: RouteValue | RouteValue[] | undefined,
): RouteValue[] {
  if (route === undefined) {
    return [];
  }
  return Array.isArray(route) ? route : [route];
}
