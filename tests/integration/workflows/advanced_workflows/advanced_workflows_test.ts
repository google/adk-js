/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Additional end-to-end (Runner) integration tests for advanced workflow
 * scenarios: dynamic fan-out/fan-in, mid-graph HITL resume, multi-trigger
 * re-execution, and a conditional dynamic loop.
 */

import {
  Event,
  FunctionNode,
  JoinNode,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  collect,
  createWorkflowRunner,
  finalOutput,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — dynamic fan-out / fan-in', () => {
  it('fans out concurrent ctx.runNode calls and aggregates results', async () => {
    const worker = new FunctionNode('work', (_c, item: number) => item * 10);
    const wf = new Workflow({
      name: 'dynamic_fan_out_fan_in',
      dynamicEntry: async (ctx) => {
        const items = [1, 2, 3];
        const results = await Promise.all(
          items.map((i) => ctx.runNode(worker, i, {runId: `w${i}`})),
        );
        return results.map((r) => r.output);
      },
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toEqual([10, 20, 30]);
  });
});

describe('workflow integration — conditional dynamic loop', () => {
  it('loops an LLM-free refiner until a condition is met', async () => {
    const refine = new FunctionNode('refine', (_c, n: number) => n + 1);
    const wf = new Workflow({
      name: 'conditional_loop',
      dynamicEntry: async (ctx) => {
        let value = 0;
        let iterations = 0;
        while (value < 5) {
          value = (await ctx.runNode(refine, value, {runId: `r${iterations}`}))
            .output as number;
          iterations++;
        }
        return {value, iterations};
      },
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toEqual({
      value: 5,
      iterations: 5,
    });
  });
});

describe('workflow integration — mid-graph HITL resume', () => {
  it('pauses in the middle of a chain and resumes without re-running upstream', async () => {
    let aRuns = 0;
    let cRuns = 0;
    const a = node(
      (_c: NodeContext, i: string) => {
        aRuns++;
        return `A(${i})`;
      },
      {name: 'a'},
    );
    const gate = node(
      (ctx: NodeContext, input: string) => {
        const answer = ctx.resumeInputs['approve'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'approve', message: 'ok?'});
        }
        return `${input}|${answer}`;
      },
      // Single-node HITL gate: re-runs on resume to read its answer.
      {name: 'gate', rerunOnResume: true},
    );
    const c = node(
      (_c: NodeContext, i: string) => {
        cRuns++;
        return `C(${i})`;
      },
      {name: 'c'},
    );
    const wf = new Workflow({
      name: 'mid_graph_hitl',
      edges: [['START', a, gate, c]],
    });
    const {run} = await createWorkflowRunner(wf);

    // Turn 1: a runs, gate interrupts, c must not run.
    const turn1 = await collect(run('start'));
    expect(aRuns).toBe(1);
    expect(cRuns).toBe(0);
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);

    // Turn 2: resume; a is fast-forwarded (not re-run), gate resolves, c runs.
    const turn2 = await collect(
      run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'approve',
              name: 'adk_request_input',
              response: {result: 'yes'},
            },
          },
        ],
      }),
    );
    expect(aRuns).toBe(1);
    expect(cRuns).toBe(1);
    // gate re-ran with its ORIGINAL input 'A(start)', resolved with 'yes'.
    expect(finalOutput(turn2)).toBe('C(A(start)|yes)');
  });
});

describe('workflow integration — multi-trigger fan-in with JoinNode', () => {
  it('joins three parallel branches produced from START', async () => {
    const mk = (name: string) =>
      new FunctionNode(name, (_c, i: string) => `${name}:${i}`);
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'triple_fan_in',
      edges: [['START', [mk('x'), mk('y'), mk('z')], join]],
    });
    const output = finalOutput(await runWorkflowOnce(wf, 'v')) as Record<
      string,
      string
    >;
    expect(output).toEqual({x: 'x:v', y: 'y:v', z: 'z:v'});
  });
});

describe('workflow integration — parallel branches emit independent events', () => {
  it('streams events from all parallel branches', async () => {
    const mk = (name: string) =>
      new FunctionNode(name, (_c, i: string) => `${name}(${i})`);
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'parallel_events',
      edges: [['START', [mk('p'), mk('q')], join]],
    });
    const events: Event[] = await runWorkflowOnce(wf, 'x');
    expect(events.some((e) => e.author === 'p')).toBe(true);
    expect(events.some((e) => e.author === 'q')).toBe(true);
    expect(events.some((e) => e.author === 'join')).toBe(true);
  });
});
