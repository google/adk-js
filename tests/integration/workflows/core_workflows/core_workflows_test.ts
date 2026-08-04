/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the major (non-LLM) workflow use cases, mirroring the
 * Python `contributing/samples/workflows` samples, run end-to-end through the
 * real Runner. Workflows are started with a text prompt (as a user would), so
 * structured inputs are produced inside nodes rather than passed as the prompt.
 */

import {
  createEvent,
  DEFAULT_ROUTE,
  FunctionNode,
  JoinNode,
  node,
  NodeContext,
  ParallelWorker,
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

describe('workflow integration — sequence', () => {
  it('threads input through a linear chain', async () => {
    const a = node((_c: NodeContext, i: string) => `${i}->A`, {name: 'a'});
    const b = node((_c: NodeContext, i: string) => `${i}->B`, {name: 'b'});
    const c = node((_c: NodeContext, i: string) => `${i}->C`, {name: 'c'});
    const wf = new Workflow({name: 'sequence', edges: [['START', a, b, c]]});

    const events = await runWorkflowOnce(wf, 'INIT');
    expect(finalOutput(events)).toBe('INIT->A->B->C');
  });
});

describe('workflow integration — route', () => {
  it('routes to a branch and falls back to DEFAULT_ROUTE', async () => {
    const routeNode = node(
      (_c: NodeContext, input: string) =>
        createEvent(
          input === 'jane' ? {output: input} : {route: 'retry', output: input},
        ),
      {name: 'route_node'},
    );
    const retry = node((_c: NodeContext, i: string) => `RETRY:${i}`, {
      name: 'retry_branch',
    });
    const gen = node((_c: NodeContext, i: string) => `GEN:${i}`, {
      name: 'generate',
    });
    const wf = new Workflow({
      name: 'route',
      edges: [
        ['START', routeNode],
        [routeNode, {retry, [DEFAULT_ROUTE]: gen}],
      ],
    });

    expect(finalOutput(await runWorkflowOnce(wf, 'john'))).toBe('RETRY:john');
    expect(finalOutput(await runWorkflowOnce(wf, 'jane'))).toBe('GEN:jane');
  });
});

describe('workflow integration — fan-out / fan-in', () => {
  it('runs branches in parallel and joins them', async () => {
    const a = node((_c: NodeContext, i: string) => `A(${i})`, {name: 'a'});
    const b = node((_c: NodeContext, i: string) => `B(${i})`, {name: 'b'});
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'fan_out_fan_in',
      edges: [['START', [a, b], join]],
    });

    expect(finalOutput(await runWorkflowOnce(wf, 'x'))).toEqual({
      a: 'A(x)',
      b: 'B(x)',
    });
  });
});

describe('workflow integration — dynamic nodes & loop', () => {
  it('runs an imperative loop that terminates', async () => {
    const inc = new FunctionNode('inc', (_c, n: number) => (n as number) + 1);
    const wf = new Workflow({
      name: 'dynamic_loop',
      dynamicEntry: async (ctx) => {
        let value = 0;
        while (value < 3) {
          value = (await ctx.runNode(inc, value)).output as number;
        }
        return value;
      },
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toBe(3);
  });
});

describe('workflow integration — parallel worker', () => {
  it('maps a list across the wrapped node with bounded concurrency', async () => {
    // The list is produced inside the workflow, then fanned out.
    const produce = node((): number[] => [1, 2, 3, 4], {name: 'produce'});
    const worker = new ParallelWorker(
      new FunctionNode('double', (_c, n: number) => (n as number) * 2),
      {maxParallelWorkers: 2},
    );
    const wf = new Workflow({
      name: 'parallel_worker',
      edges: [['START', produce, worker]],
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toEqual([2, 4, 6, 8]);
  });
});

describe('workflow integration — state', () => {
  it('shares state across nodes', async () => {
    const write = node(
      (ctx: NodeContext, i: string) => {
        ctx.state.set('greeting', `hi ${i}`);
        return i;
      },
      {name: 'write'},
    );
    const read = node((ctx: NodeContext) => ctx.state.get('greeting'), {
      name: 'read',
    });
    const wf = new Workflow({name: 'state', edges: [['START', write, read]]});
    expect(finalOutput(await runWorkflowOnce(wf, 'bob'))).toBe('hi bob');
  });
});

describe('workflow integration — nested workflow', () => {
  it('runs a workflow as a node inside another workflow', async () => {
    const inner = new Workflow({
      name: 'inner',
      edges: [
        [
          'START',
          node((_c: NodeContext, i: string) => `inner(${i})`, {name: 'in'}),
        ],
      ],
    });
    const outer = new Workflow({
      name: 'outer',
      edges: [
        [
          'START',
          inner,
          node((_c: NodeContext, i: string) => `outer[${i}]`, {name: 'out'}),
        ],
      ],
    });
    expect(finalOutput(await runWorkflowOnce(outer, 'x'))).toBe(
      'outer[inner(x)]',
    );
  });
});

describe('workflow integration — node as tool', () => {
  it('lets a node call sub-nodes imperatively', async () => {
    const add = new FunctionNode(
      'add',
      (_c, args: {a: number; b: number}) => args.a + args.b,
    );
    const orchestrator = node(
      async (ctx: NodeContext) => {
        const r1 = await ctx.runNode(add, {a: 2, b: 3});
        const r2 = await ctx.runNode(add, {a: 10, b: r1.output as number});
        return r2.output;
      },
      {name: 'orchestrator'},
    );
    const wf = new Workflow({
      name: 'node_as_tool',
      edges: [['START', orchestrator]],
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toBe(15);
  });
});

describe('workflow integration — retry', () => {
  it('retries a flaky node until it succeeds', async () => {
    let attempts = 0;
    const flaky = new FunctionNode(
      'flaky',
      () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 3, initialDelay: 0.001, jitter: 0}},
    );
    const wf = new Workflow({name: 'retry', edges: [['START', flaky]]});
    expect(finalOutput(await runWorkflowOnce(wf, 'x'))).toBe('ok');
    expect(attempts).toBe(3);
  });
});

describe('workflow integration — request_input (HITL)', () => {
  it('pauses for input and resumes on a function response', async () => {
    const gate = node(
      (ctx: NodeContext, input: string) => {
        const answer = ctx.resumeInputs['confirm'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'confirm', message: 'ok?'});
        }
        // On resume, `input` must still be the original 'start', not the
        // function-response message.
        return `${input}:${answer}`;
      },
      // Single-node HITL gate: re-runs on resume to read its answer (Python's
      // rerun_on_resume=True). The default (two-node) semantics are covered by
      // the request_input two-node test below.
      {name: 'gate', rerunOnResume: true},
    );
    const wf = new Workflow({name: 'request_input', edges: [['START', gate]]});
    const {run} = await createWorkflowRunner(wf);

    const turn1 = await collect(run('start'));
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);

    const turn2 = await collect(
      run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'confirm',
              name: 'adk_request_input',
              response: {result: 'yes'},
            },
          },
        ],
      }),
    );
    expect(finalOutput(turn2)).toBe('start:yes');
  });

  it('two-node pattern: a rerun_on_resume=false node feeds its reply to the next node', async () => {
    // Faithful port of Python's `request_input` two-node pattern: one node
    // raises the interrupt and, on resume (with the default rerun_on_resume=
    // false), does NOT re-run — its output becomes the resume value, which is
    // passed as input to its successor.
    let askRuns = 0;
    const ask = node(
      (_c: NodeContext) => {
        askRuns++;
        return new RequestInput({interruptId: 'review', message: 'reply?'});
      },
      {name: 'ask'},
    );
    const handle = node(
      (_c: NodeContext, reply: string) => `handled(${reply})`,
      {name: 'handle'},
    );
    const wf = new Workflow({
      name: 'request_input_two_node',
      edges: [['START', ask, handle]],
    });
    const {run} = await createWorkflowRunner(wf);

    const turn1 = await collect(run('start'));
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);
    expect(askRuns).toBe(1);

    const turn2 = await collect(
      run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'review',
              name: 'adk_request_input',
              response: {result: 'approve'},
            },
          },
        ],
      }),
    );
    // `ask` did NOT re-run; its reply flowed to `handle` as input.
    expect(askRuns).toBe(1);
    expect(finalOutput(turn2)).toBe('handled(approve)');
  });
});
