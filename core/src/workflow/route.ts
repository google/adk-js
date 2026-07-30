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
