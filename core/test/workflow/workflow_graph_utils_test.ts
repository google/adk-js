/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseNode, START} from '../../src/workflow/base_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {
  buildNode,
  isNodeLike,
  isPlainObject,
} from '../../src/workflow/utils/workflow_graph_utils.js';
import {driveNode, FnNode} from './test_helpers.js';

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

  it('rejects values no builder matches (no node types wired in the engine core)', () => {
    expect(isNodeLike({})).toBe(false);
    expect(isNodeLike('nope')).toBe(false);
    expect(isNodeLike(42)).toBe(false);
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

  it('wraps a node in a ParallelWorker when requested', () => {
    const node = new FnNode('n', (_c, i) => i);
    expect(buildNode(node, {parallelWorker: true})).toBeInstanceOf(
      ParallelWorker,
    );
  });
});

describe('buildNode — overriding an already-built node', () => {
  it('returns the same instance when there is nothing to override', () => {
    const original = new FnNode('keep', (_c, i) => i);
    // Identity matters: callers compare what they passed in against what the
    // graph holds.
    expect(buildNode(original)).toBe(original);
    expect(buildNode(original, {})).toBe(original);
  });

  it('applies node property overrides instead of dropping them', () => {
    const original = new FnNode('original', (_c, i) => i);
    const built = buildNode(original, {
      name: 'renamed',
      description: 'a description',
      timeout: 5,
      rerunOnResume: true,
    });

    expect(built).not.toBe(original);
    expect(built.name).toBe('renamed');
    expect(built.description).toBe('a description');
    expect(built.timeout).toBe(5);
    expect(built.rerunOnResume).toBe(true);
  });

  it('leaves the original node untouched', () => {
    const original = new FnNode('original', (_c, i) => i);
    buildNode(original, {name: 'renamed', timeout: 5});

    // A node can sit in two graphs; overriding for one must not reach the other.
    expect(original.name).toBe('original');
    expect(original.timeout).toBeUndefined();
  });

  it('keeps the node’s class and behaviour', async () => {
    const original = new FnNode('echo', (_c, input) => `echo:${input}`);
    const built = buildNode(original, {name: 'renamed'});

    expect(built).toBeInstanceOf(FnNode);
    const {output} = await driveNode(built, 'hi');
    expect(output).toBe('echo:hi');
  });

  it('recomputes the prepared retry config when retryConfig is overridden', () => {
    const original = new FnNode('n', (_c, i) => i, {
      retryConfig: {maxAttempts: 2},
    });
    const built = buildNode(original, {retryConfig: {maxAttempts: 7}});

    expect(built.retryConfig).toEqual({maxAttempts: 7});
    // The prepared form is derived at construction; copying it would leave the
    // node retrying on the policy it was overriding.
    expect(built.preparedRetryConfig?.maxAttempts).toBe(7);
  });

  it('rejects a blank name override', () => {
    const original = new FnNode('original', (_c, i) => i);
    expect(() => buildNode(original, {name: '   '})).toThrow();
  });

  it('overrides the inner node when wrapping in a parallel worker', () => {
    const original = new FnNode('inner', (_c, i) => i);
    const built = buildNode(original, {parallelWorker: true, timeout: 3});

    expect(built).toBeInstanceOf(ParallelWorker);
    expect(original.timeout).toBeUndefined();
  });
});
