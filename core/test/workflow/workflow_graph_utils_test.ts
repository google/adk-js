/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseNode, START} from '../../src/workflow/base_node.js';
import {
  buildNode,
  isNodeLike,
  isPlainObject,
} from '../../src/workflow/utils/workflow_graph_utils.js';
import {FnNode} from './test_helpers.js';

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

  it('throws when parallelWorker is requested but unavailable', () => {
    const node = new FnNode('n', (_c, i) => i);
    expect(() => buildNode(node, {parallelWorker: true})).toThrow();
  });
});
