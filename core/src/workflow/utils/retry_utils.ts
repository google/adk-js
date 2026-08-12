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
 * Resolves the runtime name of a thrown value for exception-name matching.
 * Mirrors Python's `type(exception).__name__`.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    // `name` is set by well-behaved Error subclasses; fall back to the
    // constructor name for plain `throw new Error()` cases.
    return error.name || error.constructor.name;
  }
  if (typeof error === 'object' && error !== null) {
    return error.constructor.name;
  }
  return typeof error;
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
  if (exceptions !== undefined && !exceptions.includes(errorName(error))) {
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
  delay = Math.min(delay, maxDelay);

  if (jitter > 0.0) {
    // random.uniform(-jitter*delay, jitter*delay)
    const span = jitter * delay;
    const randomOffset = -span + randomFn() * (2 * span);
    delay = Math.max(0.0, delay + randomOffset);
  }

  return delay;
}
