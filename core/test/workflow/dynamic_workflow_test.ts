/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

describe('Phase 4 — dynamic (imperative) workflows', () => {
  it('runs an imperative dynamicEntry driving ctx.runNode()', async () => {
    const step = new FunctionNode('step', (_c, input) => `step(${input})`);
    const wf = new Workflow({
      name: 'dyn',
      dynamicEntry: async (ctx, input) => {
        const child = await ctx.runNode(step, input);
        return `wrapped[${child.output}]`;
      },
    });
    expect((await driveWorkflow(wf, 'x')).output).toBe('wrapped[step(x)]');
  });

  it('supports a bounded loop (the cycle case that used to hang)', async () => {
    // Increment until >= 3; a natural JS loop, terminated by user code.
    const inc = new FunctionNode('inc', (_c, n: number) => (n as number) + 1);
    const wf = new Workflow({
      name: 'loop',
      dynamicEntry: async (ctx, input) => {
        let value = input as number;
        let iterations = 0;
        while (value < 3) {
          const child = await ctx.runNode(inc, value);
          value = child.output as number;
          iterations++;
        }
        return {value, iterations};
      },
    });
    expect((await driveWorkflow(wf, 0)).output).toEqual({
      value: 3,
      iterations: 3,
    });
  });

  it('assigns distinct run ids to repeated dynamic calls (streams each event)', async () => {
    const emit = new FunctionNode('emit', (_c, n) => `emit(${n})`);
    const wf = new Workflow({
      name: 'repeat',
      dynamicEntry: async (ctx) => {
        const outs: unknown[] = [];
        for (let i = 0; i < 3; i++) {
          outs.push((await ctx.runNode(emit, i)).output);
        }
        return outs;
      },
    });
    const {events, output} = await driveWorkflow(wf);
    expect(output).toEqual(['emit(0)', 'emit(1)', 'emit(2)']);
    // Each iteration streamed its own event.
    expect(events.filter((e) => e.author === 'emit')).toHaveLength(3);
  });

  it('deduplicates concurrent ctx.runNode() calls to the same run', async () => {
    let executions = 0;
    const slow = new FunctionNode('slow', async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 10));
      return 'done';
    });
    const wf = new Workflow({
      name: 'dedup',
      dynamicEntry: async (ctx) => {
        // Same explicit runId => same run path => deduped.
        const [a, b] = await Promise.all([
          ctx.runNode(slow, undefined, {runId: 'shared'}),
          ctx.runNode(slow, undefined, {runId: 'shared'}),
        ]);
        return {a: a.output, b: b.output, executions};
      },
    });
    expect((await driveWorkflow(wf)).output).toEqual({
      a: 'done',
      b: 'done',
      executions: 1,
    });
  });

  describe('custom run ids', () => {
    /** Runs `child` once automatically, then once with `runId`. */
    function workflowUsing(runId: string) {
      const child = new FunctionNode('child', (_c, item) => `handled ${item}`);
      return new Workflow({
        name: 'run-ids',
        dynamicEntry: async (ctx) => {
          const auto = await ctx.runNode(child, 'auto');
          const custom = await ctx.runNode(child, 'custom', {runId});
          return {auto: auto.output, custom: custom.output};
        },
      });
    }

    it.each(['order-a91', '42', '007'])(
      'accepts the non-colliding id %s',
      async (id) => {
        // Digits are fine in themselves -- ParallelWorker keys its fan-out by
        // item index. Only an id ADK already handed out is refused.
        expect((await driveWorkflow(workflowUsing(id))).output).toEqual({
          auto: 'handled auto',
          custom: 'handled custom',
        });
      },
    );

    it('rejects an id ADK already used for an automatic run', async () => {
      // The auto run above took '1'. Before this check, passing '1' here
      // resolved to that run's cached output -- returning 'handled auto' and
      // dropping this call's input without executing.
      await expect(driveWorkflow(workflowUsing('1'))).rejects.toThrow(
        /Invalid runId '1' for node 'child'[\s\S]*'child-1'/,
      );
    });

    it('rejects an empty id rather than silently auto-numbering it', async () => {
      await expect(driveWorkflow(workflowUsing('   '))).rejects.toThrow(
        /cannot be empty/,
      );
    });

    it('numbers around a custom id claimed first, instead of deduping onto it', async () => {
      const child = new FunctionNode('child', (_c, item) => `handled ${item}`);
      const wf = new Workflow({
        name: 'run-ids-reverse',
        dynamicEntry: async (ctx) => {
          // Custom '1' first, so the automatic sequence would otherwise walk
          // straight into it on its first call.
          const custom = await ctx.runNode(child, 'custom', {runId: '1'});
          const auto = await ctx.runNode(child, 'auto');
          return {custom: custom.output, auto: auto.output};
        },
      });

      expect((await driveWorkflow(wf)).output).toEqual({
        custom: 'handled custom',
        auto: 'handled auto',
      });
    });
  });

  it('supports the node-as-tool pattern (a node calls a sub-node)', async () => {
    const adder = new FunctionNode(
      'adder',
      (_c, args: {a: number; b: number}) => args.a + args.b,
    );
    const orchestrator = new FunctionNode('orchestrator', async (ctx) => {
      const r1 = await ctx.runNode(adder, {a: 2, b: 3});
      const r2 = await ctx.runNode(adder, {a: 10, b: r1.output as number});
      return r2.output;
    });
    const wf = new Workflow({
      name: 'node_as_tool',
      edges: [['START', orchestrator]],
    });
    expect((await driveWorkflow(wf)).output).toBe(15);
  });
});
