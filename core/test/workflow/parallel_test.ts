/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  branchPathFromString,
  commonPrefixOf,
  createSubBranch,
} from '../../src/workflow/branch_path.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

describe('Phase 6 — BranchPath', () => {
  it('creates sub-branches with and without run ids', () => {
    expect(createSubBranch('parent', {name: 'child', runId: '1'})).toBe(
      'parent.child@1',
    );
    expect(createSubBranch(undefined, {name: 'agent'})).toBe('agent');
  });

  it('computes the common prefix of branches', () => {
    expect(commonPrefixOf(['a@1.b@2', 'a@1.c@3'])).toBe('a@1');
    expect(commonPrefixOf(['a@1', 'b@1'])).toBe('');
    expect(commonPrefixOf([])).toBe('');
  });

  it('detects descendants', () => {
    const parent = branchPathFromString('a@1');
    expect(branchPathFromString('a@1.b@2').isDescendantOf(parent)).toBe(true);
    expect(branchPathFromString('a@1').isDescendantOf(parent)).toBe(false);
    expect(branchPathFromString('x@1.b@2').isDescendantOf(parent)).toBe(false);
  });
});

describe('Phase 6 — ParallelWorker', () => {
  it('maps a list input across the inner node, preserving order', async () => {
    const doubler = new FunctionNode('double', (_c, n: number) => n * 2);
    const worker = new ParallelWorker(doubler);
    const wf = new Workflow({name: 'pw', edges: [['START', worker]]});
    expect((await driveWorkflow(wf, [1, 2, 3, 4])).output).toEqual([
      2, 4, 6, 8,
    ]);
  });

  it('wraps a single (non-list) input as a one-element list', async () => {
    const worker = new ParallelWorker(new FunctionNode('id', (_c, n) => n));
    const wf = new Workflow({name: 'pw1', edges: [['START', worker]]});
    expect((await driveWorkflow(wf, 'solo')).output).toEqual(['solo']);
  });

  it('returns [] for an empty list', async () => {
    const worker = new ParallelWorker(new FunctionNode('id', (_c, n) => n));
    const wf = new Workflow({name: 'pw0', edges: [['START', worker]]});
    expect((await driveWorkflow(wf, [])).output).toEqual([]);
  });

  it('respects maxParallelWorkers (bounded concurrency)', async () => {
    let active = 0;
    let peak = 0;
    const slow = new FunctionNode('slow', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    const worker = new ParallelWorker(slow, {maxParallelWorkers: 2});
    const wf = new Workflow({name: 'bounded', edges: [['START', worker]]});
    const {output: out} = await driveWorkflow(wf, [1, 2, 3, 4, 5, 6]);
    expect(out).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('cancels remaining work and propagates the first error', async () => {
    const flaky = new FunctionNode('flaky', (_c, n: number) => {
      if (n === 3) {
        throw new Error('boom at 3');
      }
      return n;
    });
    const worker = new ParallelWorker(flaky, {maxParallelWorkers: 1});
    const wf = new Workflow({name: 'err', edges: [['START', worker]]});
    await expect(driveWorkflow(wf, [1, 2, 3, 4, 5])).rejects.toThrow(
      'boom at 3',
    );
  });

  it('is produced by node(fn, {parallelWorker: true})', async () => {
    const n = node((_c: NodeContext, x: number) => x + 1, {
      name: 'inc',
      parallelWorker: true,
      maxParallelWorkers: 3,
    });
    expect(n).toBeInstanceOf(ParallelWorker);
    const wf = new Workflow({name: 'pwnode', edges: [['START', n]]});
    expect((await driveWorkflow(wf, [10, 20, 30])).output).toEqual([
      11, 21, 31,
    ]);
  });

  it('rejects maxParallelWorkers without parallelWorker', () => {
    expect(() =>
      node((_c: NodeContext, x: unknown) => x, {
        name: 'x',
        maxParallelWorkers: 2,
      }),
    ).toThrow(/maxParallelWorkers/);
  });

  it('assigns run ids by item index for deterministic resume', async () => {
    // Each child stamps its own run id into the output. With bounded
    // concurrency the run id must still equal the item index (not the
    // call/completion order), so resume can fast-forward each item correctly.
    const worker = new ParallelWorker(
      node((ctx: NodeContext, item: string) => `${item}#${ctx.runId}`, {
        name: 'w',
      }),
      {maxParallelWorkers: 2},
    );
    const wf = new Workflow({name: 'pw_ids', edges: [['START', worker]]});
    expect((await driveWorkflow(wf, ['a', 'b', 'c', 'd'])).output).toEqual([
      'a#0',
      'b#1',
      'c#2',
      'd#3',
    ]);
  });
});
