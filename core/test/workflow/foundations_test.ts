/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  DynamicNodeFailError,
  NodeInterruptedError,
  NodeTimeoutError,
} from '../../src/workflow/errors.js';
import {
  createNodeState,
  isNodeState,
  NodeState,
} from '../../src/workflow/node_state.js';
import {NodeStatus} from '../../src/workflow/node_status.js';
import {normalizeRetryExceptions} from '../../src/workflow/retry_config.js';
import {
  getRetryDelaySeconds,
  shouldRetryNode,
} from '../../src/workflow/utils/retry_utils.js';

describe('Phase 0 — errors', () => {
  it('NodeTimeoutError carries nodeName/timeout and is instanceof Error', () => {
    const err = new NodeTimeoutError({nodeName: 'n1', timeout: 2.5});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NodeTimeoutError);
    expect(err.name).toBe('NodeTimeoutError');
    expect(err.nodeName).toBe('n1');
    expect(err.timeout).toBe(2.5);
    expect(err.message).toContain("Node 'n1' timed out after 2.5 seconds");
  });

  it('NodeInterruptedError is a distinct catchable error', () => {
    const err = new NodeInterruptedError();
    expect(err).toBeInstanceOf(NodeInterruptedError);
    expect(err.name).toBe('NodeInterruptedError');
  });

  it('DynamicNodeFailError wraps the underlying error + node path', () => {
    const cause = new TypeError('boom');
    const err = new DynamicNodeFailError({
      message: 'dynamic node failed',
      error: cause,
      errorNodePath: 'wf.child.0',
    });
    expect(err).toBeInstanceOf(DynamicNodeFailError);
    expect(err.error).toBe(cause);
    expect(err.errorNodePath).toBe('wf.child.0');
  });
});

describe('Phase 0 — NodeStatus / NodeState', () => {
  it('NodeStatus values match the Python enum ordinals', () => {
    expect(NodeStatus.INACTIVE).toBe(0);
    expect(NodeStatus.PENDING).toBe(1);
    expect(NodeStatus.RUNNING).toBe(2);
    expect(NodeStatus.COMPLETED).toBe(3);
    expect(NodeStatus.WAITING).toBe(4);
    expect(NodeStatus.FAILED).toBe(5);
    expect(NodeStatus.CANCELLED).toBe(6);
  });

  it('createNodeState applies Python-aligned defaults', () => {
    const s = createNodeState();
    expect(s.status).toBe(NodeStatus.INACTIVE);
    expect(s.attemptCount).toBe(1);
    expect(s.interrupts).toEqual([]);
    expect(s.resumeInputs).toEqual({});
    expect(s.runCounter).toBe(0);
    expect(s.runId).toBeUndefined();
    expect(s.parentRunId).toBeUndefined();
  });

  it('createNodeState overlays partial values', () => {
    const s = createNodeState({
      status: NodeStatus.RUNNING,
      attemptCount: 3,
      runId: 'r1',
    });
    expect(s.status).toBe(NodeStatus.RUNNING);
    expect(s.attemptCount).toBe(3);
    expect(s.runId).toBe('r1');
  });

  it('isNodeState recognizes valid/invalid shapes', () => {
    expect(isNodeState(createNodeState())).toBe(true);
    expect(isNodeState({})).toBe(false);
    expect(isNodeState(null)).toBe(false);
    expect(isNodeState({status: 'RUNNING'})).toBe(false);
  });
});

describe('Phase 0 — retry config normalization', () => {
  it('returns undefined (retry-all) for null/undefined', () => {
    expect(normalizeRetryExceptions(undefined)).toBeUndefined();
    expect(normalizeRetryExceptions(null)).toBeUndefined();
  });

  it('normalizes error classes and strings to class-name strings', () => {
    expect(normalizeRetryExceptions([TypeError, 'RangeError'])).toEqual([
      'TypeError',
      'RangeError',
    ]);
  });
});

describe('Phase 0 — shouldRetryNode', () => {
  const state = (attemptCount: number): NodeState =>
    createNodeState({attemptCount});

  it('never retries without a config', () => {
    expect(shouldRetryNode(new Error('x'), undefined, state(1))).toBe(false);
  });

  it('retries until maxAttempts is reached (default 5)', () => {
    expect(shouldRetryNode(new Error('x'), {}, state(1))).toBe(true);
    expect(shouldRetryNode(new Error('x'), {}, state(4))).toBe(true);
    expect(shouldRetryNode(new Error('x'), {}, state(5))).toBe(false);
  });

  it('respects an explicit maxAttempts', () => {
    expect(shouldRetryNode(new Error('x'), {maxAttempts: 2}, state(1))).toBe(
      true,
    );
    expect(shouldRetryNode(new Error('x'), {maxAttempts: 2}, state(2))).toBe(
      false,
    );
  });

  it('only retries listed exception types when provided', () => {
    const cfg = {exceptions: [TypeError]};
    expect(shouldRetryNode(new TypeError('x'), cfg, state(1))).toBe(true);
    expect(shouldRetryNode(new RangeError('x'), cfg, state(1))).toBe(false);
  });
});

describe('Phase 0 — getRetryDelaySeconds', () => {
  it('defaults to 1.0s with no config', () => {
    expect(getRetryDelaySeconds(undefined, createNodeState())).toBe(1.0);
  });

  it('applies exponential backoff (jitter disabled)', () => {
    const cfg = {initialDelay: 1, backoffFactor: 2, jitter: 0};
    // attempt 1 -> exponent 0 -> 1s
    expect(getRetryDelaySeconds(cfg, createNodeState({attemptCount: 1}))).toBe(
      1,
    );
    // attempt 3 -> exponent 2 -> 4s
    expect(getRetryDelaySeconds(cfg, createNodeState({attemptCount: 3}))).toBe(
      4,
    );
  });

  it('caps delay at maxDelay', () => {
    const cfg = {initialDelay: 10, backoffFactor: 10, maxDelay: 30, jitter: 0};
    expect(getRetryDelaySeconds(cfg, createNodeState({attemptCount: 5}))).toBe(
      30,
    );
  });

  it('applies bounded symmetric jitter using the injected RNG', () => {
    const cfg = {initialDelay: 4, backoffFactor: 1, jitter: 1};
    // randomFn=0.5 -> offset 0 -> exactly base delay (4)
    expect(
      getRetryDelaySeconds(cfg, createNodeState({attemptCount: 1}), () => 0.5),
    ).toBe(4);
    // randomFn=0 -> offset -span -> max(0, 4-4)=0
    expect(
      getRetryDelaySeconds(cfg, createNodeState({attemptCount: 1}), () => 0),
    ).toBe(0);
    // randomFn=1 -> offset +span -> 4+4=8
    expect(
      getRetryDelaySeconds(cfg, createNodeState({attemptCount: 1}), () => 1),
    ).toBe(8);
  });
});
