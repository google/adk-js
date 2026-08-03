/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errors raised by the workflow framework.
 *
 * Ported from `google/adk-python` `workflow/_errors.py`.
 *
 * Each error carries a `Symbol.for('google.adk.*')` brand and its type guard
 * matches on that brand rather than `instanceof` — mirroring the signature
 * symbols used across ADK (`isBaseLlm`, `isBaseAgent`, `isEvent`). Registered
 * symbols are shared across realms, so the brand stays correct even when two
 * copies of adk-js are loaded in one runtime (an `instanceof` check between
 * them would fail).
 */

const NODE_INTERRUPTED_ERROR_SYMBOL = Symbol.for(
  'google.adk.workflow.nodeInterruptedError',
);
const NODE_TIMEOUT_ERROR_SYMBOL = Symbol.for(
  'google.adk.workflow.nodeTimeoutError',
);
const DYNAMIC_NODE_FAIL_ERROR_SYMBOL = Symbol.for(
  'google.adk.workflow.dynamicNodeFailError',
);
const INVOCATION_ABORTED_ERROR_SYMBOL = Symbol.for(
  'google.adk.workflow.invocationAbortedError',
);

/**
 * Internal: raised when a dynamic node interrupts (HITL).
 *
 * Used exclusively by `ctx.runNode()` to signal that the dynamic child has
 * unresolved interrupt IDs. The parent's NodeRunner catches this and reads the
 * interrupt IDs from the parent's ctx (set by `ctx.runNode()` before throwing).
 *
 * Internal to the framework — not part of the public API.
 */
export class NodeInterruptedError extends Error {
  /** Brand identifying this error (see {@link isNodeInterruptedError}). */
  readonly [NODE_INTERRUPTED_ERROR_SYMBOL] = true;

  constructor(message = 'Node interrupted (awaiting resume input).') {
    super(message);
    this.name = 'NodeInterruptedError';
    // Restore prototype chain so `instanceof Error` stays true across
    // transpilation targets.
    Object.setPrototypeOf(this, NodeInterruptedError.prototype);
  }
}

/**
 * Type guard for {@link NodeInterruptedError}.
 *
 * Matches on the {@link NODE_INTERRUPTED_ERROR_SYMBOL} brand (see the file doc).
 */
export function isNodeInterruptedError(e: unknown): e is NodeInterruptedError {
  return (
    typeof e === 'object' &&
    e !== null &&
    NODE_INTERRUPTED_ERROR_SYMBOL in e &&
    e[NODE_INTERRUPTED_ERROR_SYMBOL] === true
  );
}

/**
 * Raised when a node exceeds its configured timeout.
 *
 * This is a regular `Error` (retryable) so a timed-out node can be retried via
 * `retryConfig`.
 */
export class NodeTimeoutError extends Error {
  /** Brand identifying this error (see {@link isNodeTimeoutError}). */
  readonly [NODE_TIMEOUT_ERROR_SYMBOL] = true;

  readonly nodeName: string;
  readonly timeout: number;

  /**
   * @param options.nodeName The name of the node that timed out.
   * @param options.timeout The timeout, in seconds, that was exceeded.
   */
  constructor(options: {nodeName: string; timeout: number}) {
    super(
      `Node '${options.nodeName}' timed out after ${options.timeout} seconds.`,
    );
    this.name = 'NodeTimeoutError';
    this.nodeName = options.nodeName;
    this.timeout = options.timeout;
    Object.setPrototypeOf(this, NodeTimeoutError.prototype);
  }
}

/** Type guard for {@link NodeTimeoutError} (brand-based; see the file doc). */
export function isNodeTimeoutError(e: unknown): e is NodeTimeoutError {
  return (
    typeof e === 'object' &&
    e !== null &&
    NODE_TIMEOUT_ERROR_SYMBOL in e &&
    e[NODE_TIMEOUT_ERROR_SYMBOL] === true
  );
}

/**
 * Raised when a dynamic node fails.
 *
 * Caught by the parent node's NodeRunner to propagate the error.
 * Internal to the framework — not part of the public API.
 */
export class DynamicNodeFailError extends Error {
  /** Brand identifying this error (see {@link isDynamicNodeFailError}). */
  readonly [DYNAMIC_NODE_FAIL_ERROR_SYMBOL] = true;

  readonly error: Error;
  readonly errorNodePath: string;

  /**
   * @param options.message Human-readable failure message.
   * @param options.error The underlying error thrown by the dynamic node.
   * @param options.errorNodePath The node path where the failure occurred.
   */
  constructor(options: {message: string; error: Error; errorNodePath: string}) {
    super(options.message);
    this.name = 'DynamicNodeFailError';
    this.error = options.error;
    this.errorNodePath = options.errorNodePath;
    Object.setPrototypeOf(this, DynamicNodeFailError.prototype);
  }
}

/** Type guard for {@link DynamicNodeFailError} (brand-based; see the file doc). */
export function isDynamicNodeFailError(e: unknown): e is DynamicNodeFailError {
  return (
    typeof e === 'object' &&
    e !== null &&
    DYNAMIC_NODE_FAIL_ERROR_SYMBOL in e &&
    e[DYNAMIC_NODE_FAIL_ERROR_SYMBOL] === true
  );
}

/**
 * Raised when the invocation is aborted (e.g. its abort signal fires) while the
 * engine is waiting — currently during a node's retry backoff delay.
 *
 * Distinct from a node's own failure so a caller can tell "the invocation was
 * cancelled" apart from "the node threw".
 */
export class InvocationAbortedError extends Error {
  /** Brand identifying this error (see {@link isInvocationAbortedError}). */
  readonly [INVOCATION_ABORTED_ERROR_SYMBOL] = true;

  constructor(message = 'Invocation aborted.') {
    super(message);
    this.name = 'InvocationAbortedError';
    Object.setPrototypeOf(this, InvocationAbortedError.prototype);
  }
}

/** Type guard for {@link InvocationAbortedError} (brand-based; see the file doc). */
export function isInvocationAbortedError(
  e: unknown,
): e is InvocationAbortedError {
  return (
    typeof e === 'object' &&
    e !== null &&
    INVOCATION_ABORTED_ERROR_SYMBOL in e &&
    e[INVOCATION_ABORTED_ERROR_SYMBOL] === true
  );
}
