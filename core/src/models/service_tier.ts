/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serving tiers the interactions API offers for a model call.
 *
 * Mirrors `ServiceTier` from `adk-python` (`google.adk.models.ServiceTier`).
 * Fields typed with this enum also accept a plain string, so a tier the
 * backend adds before ADK learns about it still works.
 */
export enum ServiceTier {
  /** Best-effort capacity at a lower cost, with no latency guarantee. */
  FLEX = 'flex',

  /** The default tier. */
  STANDARD = 'standard',

  /** Reserved capacity for latency-sensitive calls. */
  PRIORITY = 'priority',

  /**
   * Queued to run on off-peak capacity.
   *
   * The call waits for room instead of being turned away when capacity is
   * tight. The API returns an interaction id as soon as the work is accepted
   * rather than a result, so this tier cannot be combined with
   * `StreamingMode.SSE`.
   */
  DEFERRED = 'deferred',
}
