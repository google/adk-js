/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility functions for retrying nodes in a workflow.
 *
 * Ported from `google/adk-python` `workflow/utils/_retry_utils.py`.
 */

import {NodeState} from '../node_state.js';
import {PreparedRetryConfig} from '../retry_config.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_SECONDS = 1.0;
const DEFAULT_MAX_DELAY_SECONDS = 60.0;
const DEFAULT_BACKOFF_FACTOR = 2.0;
const DEFAULT_JITTER = 1.0;

/**
 * Resolves every runtime name a thrown value can be matched by: its class name,
 * as Python's `type(exception).__name__` gives, and any `name` assigned on top
 * of it. A subclass that never sets `this.name` inherits `'Error'`, so the two
 * disagree exactly when matching on one alone would miss.
 */
export function errorNames(error: unknown): string[] {
  if (error instanceof Error) {
    const names = [error.constructor?.name, error.name].filter(
      (name): name is string => !!name,
    );
    return [...new Set(names)];
  }
  if (typeof error === 'object' && error !== null) {
    return [error.constructor.name];
  }
  return [typeof error];
}

/**
 * Resolves the most specific runtime name of a thrown value, for reporting.
 * Mirrors Python's `type(exception).__name__`, preferring an assigned `name`
 * only when the class name carries nothing more than `Error`.
 */
export function errorName(error: unknown): string {
  const [className, assigned] = errorNames(error);
  if (className === 'Error' && assigned) {
    return assigned;
  }
  return className;
}

/** Parameters for {@link shouldRetryNode}. */
export interface ShouldRetryNodeParams {
  /** The error thrown by the node. */
  error: unknown;
  /** The node's prepared (normalized) retry configuration. */
  retryConfig: PreparedRetryConfig;
  /** The current node state (its `attemptCount` is 1-based). */
  nodeState: NodeState;
}

/**
 * Checks if a failed node should be retried based on its retry config.
 */
export function shouldRetryNode({
  error,
  retryConfig,
  nodeState,
}: ShouldRetryNodeParams): boolean {
  const attemptCount = nodeState.attemptCount;
  const maxAttempts = retryConfig.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // attemptCount starts at 1 for the original request; once it reaches
  // maxAttempts, the limit is exhausted.
  if (attemptCount >= maxAttempts) {
    return false;
  }

  const exceptions = retryConfig.exceptions;
  if (
    exceptions !== undefined &&
    !errorNames(error).some((name) => exceptions.includes(name))
  ) {
    return false;
  }

  return true;
}

/** Parameters for {@link getRetryDelaySeconds}. */
export interface GetRetryDelaySecondsParams {
  /** The node's prepared (normalized) retry configuration. */
  retryConfig: PreparedRetryConfig;
  /**
   * The current node state (its `attemptCount` is the 1-based attempt number
   * that just failed).
   */
  nodeState: NodeState;
  /** Injectable uniform RNG in [0, 1) for deterministic testing. */
  randomFn?: () => number;
}

/**
 * Calculates the delay, in seconds, before retrying a node.
 */
export function getRetryDelaySeconds({
  retryConfig,
  nodeState,
  randomFn = Math.random,
}: GetRetryDelaySecondsParams): number {
  const initialDelay =
    retryConfig.initialDelay ?? DEFAULT_INITIAL_DELAY_SECONDS;
  const maxDelay = retryConfig.maxDelay ?? DEFAULT_MAX_DELAY_SECONDS;
  const backoffFactor = retryConfig.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const jitter = retryConfig.jitter ?? DEFAULT_JITTER;

  const attemptCount = nodeState.attemptCount || 1;
  // attemptCount is the attempt number that just failed (1-based); the first
  // failure (attempt 1) uses exponent 0.
  const attemptForCalc = Math.max(0, attemptCount - 1);

  let delay = initialDelay * Math.pow(backoffFactor, attemptForCalc);

  if (jitter > 0.0) {
    delay = Math.min(delay, maxDelay / (1.0 + jitter));
    // random.uniform(-jitter*delay, jitter*delay)
    const span = jitter * delay;
    const randomOffset = -span + randomFn() * (2 * span);
    delay = Math.max(0.0, delay + randomOffset);
  }

  return Math.min(delay, maxDelay);
}
