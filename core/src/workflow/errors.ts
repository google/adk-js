/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown when a node runs longer than its `timeoutMs`.
 *
 * A plain `Error` subclass, so a timed-out node can be retried by a
 * `RetryConfig` that lists it.
 */
export class NodeTimeoutError extends Error {
  /** The name of the node that timed out. */
  readonly nodeName: string;

  /** The timeout the node exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(options: {nodeName: string; timeoutMs: number}) {
    super(
      `Node '${options.nodeName}' timed out after ${options.timeoutMs} ms.`,
    );
    this.name = 'NodeTimeoutError';
    this.nodeName = options.nodeName;
    this.timeoutMs = options.timeoutMs;
  }
}
