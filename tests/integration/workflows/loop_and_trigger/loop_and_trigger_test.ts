/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for routed (conditional) self-loops, error propagation from
 * a parallel branch, and multi-trigger re-execution.
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  FunctionNode,
  JoinNode,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {finalOutput, runWorkflowOnce} from '../_harness/workflow_test_utils.js';

describe('workflow integration — routed self-loop', () => {
  it('loops a node back to itself until a route condition ends it', async () => {
    const init = new FunctionNode('init', () => 0);
    // Counter threads via the node output; routes back to itself until >= 3.
    const worker = node(
      (_c: NodeContext, n: number) => {
        const next = (n as number) + 1;
        return createEvent({route: next < 3 ? 'again' : 'done', output: next});
      },
      {name: 'worker'},
    );
    const report = node((_c: NodeContext, n: number) => `final:${n}`, {
      name: 'report',
    });

    const wf = new Workflow({
      name: 'loop_self',
      edges: [
        ['START', init, worker],
        [worker, {again: worker, done: report}],
      ],
    });

    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toBe('final:3');
  });

  it('supports a routed loop with a DEFAULT_ROUTE exit', async () => {
    const init = new FunctionNode('init', () => 0);
    const worker = node(
      (_c: NodeContext, n: number) => {
        const next = (n as number) + 1;
        // Emit 'again' while looping; no route (=> DEFAULT) when done.
        return next < 2
          ? createEvent({route: 'again', output: next})
          : createEvent({output: next});
      },
      {name: 'worker'},
    );
    const done = node((_c: NodeContext, n: number) => `done:${n}`, {
      name: 'done',
    });
    const wf = new Workflow({
      name: 'loop_default_exit',
      edges: [
        ['START', init, worker],
        [worker, {again: worker, [DEFAULT_ROUTE]: done}],
      ],
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toBe('done:2');
  });
});

describe('workflow integration — parallel branch failure', () => {
  it('fails the workflow when a parallel branch throws', async () => {
    const good = new FunctionNode('good', (_c, i: string) => `good(${i})`);
    const bad = new FunctionNode('bad', () => {
      throw new Error('branch exploded');
    });
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'parallel_error',
      edges: [['START', [good, bad], join]],
    });
    await expect(runWorkflowOnce(wf, 'x')).rejects.toThrow('branch exploded');
  });
});

describe('workflow integration — multi-trigger', () => {
  it('re-executes a non-join node once per predecessor trigger', async () => {
    let cRuns = 0;
    const a = new FunctionNode('a', (_c, i: string) => `a(${i})`);
    const b = new FunctionNode('b', (_c, i: string) => `b(${i})`);
    const c = new FunctionNode('c', (_c, input: string) => {
      cRuns++;
      return `c(${input})`;
    });
    // c has two predecessors and is NOT a JoinNode -> triggered twice.
    const wf = new Workflow({
      name: 'multi_triggers',
      edges: [
        ['START', [a, b]],
        [a, c],
        [b, c],
      ],
    });

    await runWorkflowOnce(wf, 'x');
    expect(cRuns).toBe(2);
  });
});
