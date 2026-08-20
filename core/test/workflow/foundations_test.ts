/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  DynamicNodeFailError,
  InvocationAbortedError,
  isInvocationAbortedError,
  isNodeTimeoutError,
  NodeInterruptedError,
  NodeTimeoutError,
} from '../../src/workflow/errors.js';
import {
  createNodeState,
  isNodeState,
  NodeState,
} from '../../src/workflow/node_state.js';
import {NodeStatus} from '../../src/workflow/node_status.js';
import {
  normalizeRetryExceptions,
  prepareRetryConfig,
} from '../../src/workflow/retry_config.js';
import {
  errorName,
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

  it('InvocationAbortedError is guarded by name (not by other error guards)', () => {
    const err = new InvocationAbortedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvocationAbortedError');
    expect(isInvocationAbortedError(err)).toBe(true);
    // Guards are distinct: a different error is not misidentified.
    expect(
      isInvocationAbortedError(
        new NodeTimeoutError({nodeName: 'n', timeout: 1}),
      ),
    ).toBe(false);
    expect(isNodeTimeoutError(err)).toBe(false);
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

  it('prepareRetryConfig validates exceptions eagerly (throws on malformed)', () => {
    expect(() =>
      prepareRetryConfig({
        exceptions: [42 as unknown as string],
      }),
    ).toThrow(/error class names/i);
    // Well-formed config normalizes the exception filter up front.
    expect(prepareRetryConfig({exceptions: [TypeError]}).exceptions).toEqual([
      'TypeError',
    ]);
  });
});

describe('Phase 0 — shouldRetryNode', () => {
  const state = (attemptCount: number): NodeState =>
    createNodeState({attemptCount});

  it('retries until maxAttempts is reached (default 5)', () => {
    const cfg = prepareRetryConfig({});
    const check = (nodeState: NodeState) =>
      shouldRetryNode({error: new Error('x'), retryConfig: cfg, nodeState});
    expect(check(state(1))).toBe(true);
    expect(check(state(4))).toBe(true);
    expect(check(state(5))).toBe(false);
  });

  it('respects an explicit maxAttempts', () => {
    const cfg = prepareRetryConfig({maxAttempts: 2});
    const check = (nodeState: NodeState) =>
      shouldRetryNode({error: new Error('x'), retryConfig: cfg, nodeState});
    expect(check(state(1))).toBe(true);
    expect(check(state(2))).toBe(false);
  });

  it('only retries listed exception types when provided', () => {
    const cfg = prepareRetryConfig({exceptions: [TypeError]});
    expect(
      shouldRetryNode({
        error: new TypeError('x'),
        retryConfig: cfg,
        nodeState: state(1),
      }),
    ).toBe(true);
    expect(
      shouldRetryNode({
        error: new RangeError('x'),
        retryConfig: cfg,
        nodeState: state(1),
      }),
    ).toBe(false);
  });

  it('matches a subclass that never assigns this.name', () => {
    class RateLimitedError extends Error {}
    const cfg = prepareRetryConfig({exceptions: [RateLimitedError]});
    expect(
      shouldRetryNode({
        error: new RateLimitedError('x'),
        retryConfig: cfg,
        nodeState: state(1),
      }),
    ).toBe(true);
    expect(
      shouldRetryNode({
        error: new Error('x'),
        retryConfig: cfg,
        nodeState: state(1),
      }),
    ).toBe(false);
  });

  it('matches a subclass by class name or by an assigned name', () => {
    class RetryableError extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'Retryable';
      }
    }
    for (const cfg of [
      prepareRetryConfig({exceptions: ['Retryable']}),
      prepareRetryConfig({exceptions: [RetryableError]}),
    ]) {
      expect(
        shouldRetryNode({
          error: new RetryableError('x'),
          retryConfig: cfg,
          nodeState: state(1),
        }),
      ).toBe(true);
    }
  });
});

describe('Phase 0 — errorName', () => {
  it('reports the class name of a subclass that never assigns this.name', () => {
    class RateLimitedError extends Error {}
    expect(errorName(new RateLimitedError('x'))).toBe('RateLimitedError');
  });

  it('keeps an assigned name when the class name adds nothing', () => {
    const err = new Error('x');
    err.name = 'Custom';
    expect(errorName(err)).toBe('Custom');
    expect(errorName(new Error('x'))).toBe('Error');
  });

  it('reports non-Error throws by type', () => {
    expect(errorName('boom')).toBe('string');
    expect(errorName(7)).toBe('number');
  });
});

describe('Phase 0 — getRetryDelaySeconds', () => {
  it('applies exponential backoff (jitter disabled)', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 1,
      backoffFactor: 2,
      jitter: 0,
    });
    // attempt 1 -> exponent 0 -> 1s
    expect(
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 1}),
      }),
    ).toBe(1);
    // attempt 3 -> exponent 2 -> 4s
    expect(
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 3}),
      }),
    ).toBe(4);
  });

  it('caps delay at maxDelay', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 10,
      backoffFactor: 10,
      maxDelay: 30,
      jitter: 0,
    });
    expect(
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 5}),
      }),
    ).toBe(30);
  });

  it('applies bounded symmetric jitter using the injected RNG', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 4,
      backoffFactor: 1,
      jitter: 1,
    });
    const delayWith = (randomFn: () => number) =>
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 1}),
        randomFn,
      });
    // randomFn=0.5 -> offset 0 -> exactly base delay (4)
    expect(delayWith(() => 0.5)).toBe(4);
    // randomFn=0 -> offset -span -> max(0, 4-4)=0
    expect(delayWith(() => 0)).toBe(0);
    // randomFn=1 -> offset +span -> 4+4=8
    expect(delayWith(() => 1)).toBe(8);
  });

  it('never exceeds maxDelay once jitter is applied', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 1,
      backoffFactor: 2,
      maxDelay: 60,
      jitter: 1,
    });
    for (let attemptCount = 1; attemptCount <= 12; attemptCount++) {
      for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = getRetryDelaySeconds({
          retryConfig: cfg,
          nodeState: createNodeState({attemptCount}),
          randomFn: () => draw,
        });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(60);
      }
    }
  });

  it('caps the pre-jitter delay so the widest draw lands on maxDelay', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 1,
      backoffFactor: 2,
      maxDelay: 60,
      jitter: 1,
    });
    const delayWith = (randomFn: () => number) =>
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 10}),
        randomFn,
      });
    expect(delayWith(() => 0.5)).toBe(30);
    expect(delayWith(() => 1)).toBe(60);
    expect(delayWith(() => 0)).toBe(0);
  });

  it('still honours maxDelay when jitter is disabled', () => {
    const cfg = prepareRetryConfig({
      initialDelay: 1,
      backoffFactor: 2,
      maxDelay: 60,
      jitter: 0,
    });
    expect(
      getRetryDelaySeconds({
        retryConfig: cfg,
        nodeState: createNodeState({attemptCount: 20}),
      }),
    ).toBe(60);
  });
});
