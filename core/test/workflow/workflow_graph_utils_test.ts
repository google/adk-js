/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BaseNode, START} from '../../src/workflow/base_node.js';
import {NodeLike} from '../../src/workflow/graph.js';
import {
  buildNode,
  isNodeLike,
  isPlainObject,
  NodeBuilder,
  registerNodeBuilder,
  registerParallelWorkerFactory,
} from '../../src/workflow/utils/workflow_graph_utils.js';
import {FnNode} from './test_helpers.js';

/** A sentinel node-like value matched by a test builder via its `brand`. */
const branded = (brand: string): NodeLike => ({brand}) as unknown as NodeLike;

/** Builds a {@link NodeBuilder} that matches `branded(brand)` and names its node. */
function sentinelBuilder(
  id: string,
  brand: string,
  nodeName: string,
  priority?: number,
): NodeBuilder {
  return {
    id,
    priority,
    match: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      (value as {brand?: unknown}).brand === brand,
    build: () => new FnNode(nodeName, (_c, i) => i),
  };
}

describe('isPlainObject', () => {
  it('is true for object literals', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({a: 1})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('is false for arrays, null, primitives and class instances', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(new FnNode('n', (_c, i) => i))).toBe(false);
  });
});

describe('isNodeLike', () => {
  it('recognizes START and BaseNode instances', () => {
    expect(isNodeLike('START')).toBe(true);
    expect(isNodeLike(new FnNode('n', (_c, i) => i))).toBe(true);
  });

  it('rejects plain values with no registered builder', () => {
    expect(isNodeLike({})).toBe(false);
    expect(isNodeLike('nope')).toBe(false);
  });

  it('recognizes a value matched by a registered builder', () => {
    registerNodeBuilder(sentinelBuilder('like', 'like', 'built'));
    expect(isNodeLike(branded('like'))).toBe(true);
  });
});

describe('buildNode', () => {
  it('returns the START sentinel and existing nodes directly', () => {
    expect(buildNode('START')).toBe(START);
    const node = new FnNode('n', (_c, i) => i);
    expect(buildNode(node)).toBe(node);
  });

  it('throws for an unsupported value', () => {
    expect(() => buildNode(42 as unknown as BaseNode)).toThrow();
  });

  it('throws when maxParallelWorkers is set without parallelWorker', () => {
    const node = new FnNode('n', (_c, i) => i);
    expect(() => buildNode(node, {maxParallelWorkers: 2})).toThrow();
  });

  it('delegates to a registered builder', () => {
    registerNodeBuilder(sentinelBuilder('build', 'build', 'built'));
    expect(buildNode(branded('build')).name).toBe('built');
  });
});

describe('registerNodeBuilder', () => {
  it('is idempotent by id (re-registering replaces, not duplicates)', () => {
    registerNodeBuilder(sentinelBuilder('dup', 'dup', 'first'));
    registerNodeBuilder(sentinelBuilder('dup', 'dup', 'second'));
    expect(buildNode(branded('dup')).name).toBe('second');
  });

  it('consults higher-priority builders first', () => {
    registerNodeBuilder(sentinelBuilder('lo', 'pri', 'low', 0));
    registerNodeBuilder(sentinelBuilder('hi', 'pri', 'high', 10));
    expect(buildNode(branded('pri')).name).toBe('high');
  });

  it('breaks priority ties by registration order', () => {
    registerNodeBuilder(sentinelBuilder('first', 'tie', 'first', 0));
    registerNodeBuilder(sentinelBuilder('second', 'tie', 'second', 0));
    expect(buildNode(branded('tie')).name).toBe('first');
  });

  it('requires an id', () => {
    expect(() =>
      registerNodeBuilder({
        id: '',
        match: () => false,
        build: () => new FnNode('x', (_c, i) => i),
      }),
    ).toThrow();
  });
});

describe('registerParallelWorkerFactory', () => {
  it('uses the registered factory and rejects a conflicting one', () => {
    const factory = vi.fn((inner: BaseNode) => inner);
    registerParallelWorkerFactory(factory);
    // Re-registering the same factory reference is a no-op.
    expect(() => registerParallelWorkerFactory(factory)).not.toThrow();
    // A different factory conflicts and is rejected.
    expect(() =>
      registerParallelWorkerFactory((inner: BaseNode) => inner),
    ).toThrow();

    const node = new FnNode('worker', (_c, i) => i);
    const wrapped = buildNode(node, {parallelWorker: true});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(wrapped).toBe(node);
  });
});
