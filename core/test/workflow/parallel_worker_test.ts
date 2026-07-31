/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {buildNode} from '../../src/workflow/utils/workflow_graph_utils.js';
import {driveNode} from './test_helpers.js';

describe('ParallelWorker', () => {
  it('maps a list input through the inner node, preserving order', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const {output} = await driveNode(new ParallelWorker(inner), [1, 2, 3, 4]);
    expect(output).toEqual([2, 4, 6, 8]);
  });

  it('treats a non-list input as a single-element list', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const {output} = await driveNode(new ParallelWorker(inner), 5);
    expect(output).toEqual([10]);
  });

  it('yields an empty list for an empty input', async () => {
    const inner = new FunctionNode('id', (_c, x) => x);
    const {output} = await driveNode(new ParallelWorker(inner), []);
    expect(output).toEqual([]);
  });

  it('bounds concurrency by maxParallelWorkers', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FunctionNode('track', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    const {output} = await driveNode(
      new ParallelWorker(inner, {maxParallelWorkers: 2}),
      [1, 2, 3, 4, 5],
    );
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects maxParallelWorkers < 1', () => {
    const inner = new FunctionNode('x', (_c, v) => v);
    expect(() => new ParallelWorker(inner, {maxParallelWorkers: 0})).toThrow(
      /greater than or equal to 1/,
    );
  });

  it('propagates the first error from a failing item', async () => {
    const inner = new FunctionNode('boom', (_c, n: number) => {
      if (n === 3) {
        throw new Error('boom at 3');
      }
      return n;
    });
    await expect(
      driveNode(new ParallelWorker(inner), [1, 2, 3, 4]),
    ).rejects.toThrow('boom at 3');
  });
});

describe('ParallelWorker registry factory', () => {
  it('buildNode wraps the built node when parallelWorker is requested', () => {
    const node = buildNode((_c: unknown, n: number) => n, {
      name: 'w',
      parallelWorker: true,
    });
    expect(node).toBeInstanceOf(ParallelWorker);
  });

  it('rejects maxParallelWorkers without parallelWorker', () => {
    expect(() =>
      buildNode(() => {}, {name: 'x', maxParallelWorkers: 2}),
    ).toThrow(/maxParallelWorkers can only be set/);
  });
});

describe('JoinNode', () => {
  it('emits its aggregated input as output and requires all predecessors', async () => {
    const join = new JoinNode({name: 'join'});
    const aggregated = {a: 1, b: 2};
    const {output} = await driveNode(join, aggregated);
    expect(output).toEqual(aggregated);
    expect(join.requiresAllPredecessors).toBe(true);
  });
});
