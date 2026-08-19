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

  describe('ctx.runNode() accepts what edges accept', () => {
    it('runs a plain function without wrapping it in node()', async () => {
      function shout(_c: unknown, input: string) {
        return `${input}!`;
      }
      const wf = new Workflow({
        name: 'bare-function',
        dynamicEntry: async (ctx, input) =>
          (await ctx.runNode(shout, input)).output,
      });

      expect((await driveWorkflow(wf, 'hi')).output).toBe('hi!');
    });

    it('names the node after the value, as an edge would', async () => {
      function shout(_c: unknown, input: string) {
        return `${input}!`;
      }
      const wf = new Workflow({
        name: 'bare-function-events',
        dynamicEntry: async (ctx, input) =>
          (await ctx.runNode(shout, input)).output,
      });

      const {events} = await driveWorkflow(wf, 'hi');
      expect(events.some((e) => e.author === 'shout')).toBe(true);
    });

    it('still takes an already-built node', async () => {
      const built = new FunctionNode(
        'built',
        (_c, input: string) => `${input}?`,
      );
      const wf = new Workflow({
        name: 'built-node',
        dynamicEntry: async (ctx, input) =>
          (await ctx.runNode(built, input)).output,
      });

      expect((await driveWorkflow(wf, 'hi')).output).toBe('hi?');
    });

    it('keeps the automatic run-id sequence across calls', async () => {
      function step(_c: unknown, input: string) {
        return input;
      }
      const wf = new Workflow({
        name: 'sequence-ids',
        dynamicEntry: async (ctx) => {
          const a = await ctx.runNode(step, 'a');
          const b = await ctx.runNode(step, 'b');
          return [a.output, b.output];
        },
      });

      const {events, output} = await driveWorkflow(wf);
      expect(output).toEqual(['a', 'b']);
      expect(events.filter((e) => e.author === 'step').length).toBe(2);
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

    it('accepts an id that cannot be mistaken for an automatic one', async () => {
      expect((await driveWorkflow(workflowUsing('order-a91'))).output).toEqual({
        auto: 'handled auto',
        custom: 'handled custom',
      });
    });

    it.each(['1', '42', '007'])(
      'rejects the all-digit id %s for an auto-numbered node',
      async (id) => {
        // All three share the automatic namespace, so which one collides is a
        // function of how many runs this turn happens to make. '1' resolved to
        // the auto run's cached output outright; the others waited for a turn
        // that ran the node often enough to reach them.
        await expect(driveWorkflow(workflowUsing(id))).rejects.toThrow(
          new RegExp(
            `Invalid runId '${id}' for node 'child'[\\s\\S]*child-${id}`,
          ),
        );
      },
    );

    it('rejects an empty id rather than silently auto-numbering it', async () => {
      await expect(driveWorkflow(workflowUsing('   '))).rejects.toThrow(
        /cannot be empty/,
      );
    });

    it('rejects the same mix in the opposite order', async () => {
      // The case that used to pass. Numbering around the claimed '1' worked
      // this turn and broke the next one, so the guard has to be symmetric:
      // the same program must not be an error in one order and silent data
      // corruption in the other.
      const child = new FunctionNode('child', (_c, item) => `handled ${item}`);
      const wf = new Workflow({
        name: 'run-ids-reverse',
        dynamicEntry: async (ctx) => {
          const custom = await ctx.runNode(child, 'custom', {runId: '1'});
          const auto = await ctx.runNode(child, 'auto');
          return {custom: custom.output, auto: auto.output};
        },
      });

      await expect(driveWorkflow(wf)).rejects.toThrow(
        /Invalid runId '1' for node 'child'[\s\S]*child-1/,
      );
    });

    it('lets a caller that names every run keep using indices', async () => {
      // No automatic run of `child` here, so the caller owns the whole
      // namespace and nothing can collide -- this is how ParallelWorker keys
      // its fan-out by item index.
      const child = new FunctionNode('child', (_c, item) => `handled ${item}`);
      const wf = new Workflow({
        name: 'run-ids-all-custom',
        dynamicEntry: async (ctx) => {
          const runs = await Promise.all(
            ['a', 'b', 'c'].map((item, i) =>
              ctx.runNode(child, item, {runId: String(i)}),
            ),
          );
          return runs.map((run) => run.output);
        },
      });

      expect((await driveWorkflow(wf)).output).toEqual([
        'handled a',
        'handled b',
        'handled c',
      ]);
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
