/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  JoinNode,
  node,
  NodeContext,
  START,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {makeInvocationContext, runToCompletion} from './workflow_test_utils.js';

/** A node that appends its name to `log` and outputs `output`. */
function recording(log: string[], name: string, output?: unknown) {
  return node(
    () => {
      log.push(name);
      return output;
    },
    {name},
  );
}

describe('Workflow', () => {
  it('validates its graph eagerly', () => {
    expect(
      () =>
        new Workflow({
          name: 'invalid',
          edges: [[node(() => 'a', {name: 'a'}), node(() => 'b', {name: 'b'})]],
        }),
    ).toThrow('Graph validation failed. START node');
  });

  it('runs two nodes in sequence and returns the terminal output', async () => {
    const log: string[] = [];
    const wf = new Workflow({
      name: 'sequence',
      edges: [
        [
          START,
          recording(log, 'first', 'one'),
          recording(log, 'second', 'two'),
        ],
      ],
    });

    const {ctx} = await runToCompletion(wf, 'start');

    expect(log).toEqual(['first', 'second']);
    expect(ctx.output).toBe('two');
  });

  it('passes each node output on as the next node input', async () => {
    const seen: unknown[] = [];
    const wf = new Workflow({
      name: 'propagation',
      edges: [
        [
          START,
          node(
            (_ctx, nodeInput) => {
              seen.push(nodeInput);
              return 'from first';
            },
            {name: 'first'},
          ),
          node(
            (_ctx, nodeInput) => {
              seen.push(nodeInput);
              return 'done';
            },
            {name: 'second'},
          ),
        ],
      ],
    });

    await runToCompletion(wf, 'workflow input');

    expect(seen).toEqual(['workflow input', 'from first']);
  });

  it('streams node events before producing the output', async () => {
    const wf = new Workflow({
      name: 'streaming',
      edges: [
        [
          START,
          node(
            async function* (
              ctx: NodeContext,
            ): AsyncGenerator<Event, void, void> {
              yield createEvent({
                author: 'talker',
                content: {parts: [{text: 'thinking'}]},
              });
              ctx.output = 'answer';
            },
            {name: 'talker'},
          ),
        ],
      ],
    });

    const {events, ctx} = await runToCompletion(wf);

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual(['thinking']);
    expect(ctx.output).toBe('answer');
  });

  it('accepts an empty graph and produces nothing', async () => {
    const {events, ctx} = await runToCompletion(
      new Workflow({name: 'empty', edges: []}),
    );

    expect(events).toEqual([]);
    expect(ctx.output).toBeUndefined();
  });

  it('auto-wraps a bare function used in the edge list', async () => {
    function greet() {
      return 'hello';
    }
    const wf = new Workflow({name: 'autoWrap', edges: [[START, greet]]});

    const {ctx} = await runToCompletion(wf);

    expect(wf.graph.nodes.map((n) => n.name)).toEqual(['__START__', 'greet']);
    expect(ctx.output).toBe('hello');
  });

  it('gives every START successor the workflow input', async () => {
    const seen: unknown[] = [];
    const record = (name: string) =>
      node(
        (_ctx, nodeInput) => {
          seen.push([name, nodeInput]);
        },
        {name},
      );
    const wf = new Workflow({
      name: 'fanOut',
      edges: [[START, [record('a'), record('b')]]],
    });

    await runToCompletion(wf, 'shared');

    expect(seen).toEqual([
      ['a', 'shared'],
      ['b', 'shared'],
    ]);
  });

  it('fans in through a JoinNode once every predecessor completed', async () => {
    const log: string[] = [];
    const join = new JoinNode({name: 'join'});
    const summarize = node(
      (_ctx, nodeInput) => {
        log.push('summarize');
        return nodeInput;
      },
      {name: 'summarize'},
    );
    const a = recording(log, 'a', 'outA');
    const b = recording(log, 'b', 'outB');
    const wf = new Workflow({
      name: 'fanIn',
      edges: [
        [START, [a, b]],
        [a, join],
        [b, join],
        [join, summarize],
      ],
    });

    const {ctx} = await runToCompletion(wf);

    expect(log).toEqual(['a', 'b', 'summarize']);
    expect(ctx.output).toEqual({a: 'outA', b: 'outB'});
  });

  it('delivers undefined for predecessors that produced no output', async () => {
    const a = node(() => undefined, {name: 'a'});
    const b = node(() => undefined, {name: 'b'});
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'fanInEmpty',
      edges: [
        [START, [a, b]],
        [a, join],
        [b, join],
      ],
    });

    const {ctx} = await runToCompletion(wf);

    expect(ctx.output).toEqual({a: undefined, b: undefined});
  });

  it('does not run a fan-in node until every predecessor completed', async () => {
    const log: string[] = [];
    const gate = node(() => 'go', {name: 'gate'});
    const slowBranch = node(() => 'slow', {name: 'slowBranch'});
    const join = new JoinNode({name: 'join'});
    const after = node(
      () => {
        log.push('after');
        return 'end';
      },
      {name: 'after'},
    );
    const wf = new Workflow({
      name: 'barrier',
      edges: [
        [START, gate, slowBranch],
        [gate, join],
        [slowBranch, join],
        [join, after],
      ],
    });

    await runToCompletion(wf);

    expect(log).toEqual(['after']);
  });

  it('loops through a routed cycle until the break route is taken', async () => {
    let count = 0;
    const step = node(
      (ctx: NodeContext) => {
        count++;
        ctx.route = count < 3 ? 'again' : 'done';
        return count;
      },
      {name: 'step'},
    );
    const finish = node((_ctx, nodeInput) => `ran ${String(nodeInput)} times`, {
      name: 'finish',
    });
    const wf = new Workflow({
      name: 'loop',
      edges: [
        [START, step],
        {fromNode: step, toNode: step, route: 'again'},
        {fromNode: step, toNode: finish, route: 'done'},
      ],
    });

    const {ctx} = await runToCompletion(wf);

    expect(count).toBe(3);
    expect(ctx.output).toBe('ran 3 times');
  });

  it('gives each run of a node a sequential run id', async () => {
    const paths: string[] = [];
    let count = 0;
    const step = node(
      (ctx: NodeContext) => {
        paths.push(ctx.nodePath);
        count++;
        ctx.route = count < 3 ? 'again' : 'done';
      },
      {name: 'step'},
    );
    const wf = new Workflow({
      name: 'runIds',
      edges: [
        [START, step],
        {fromNode: step, toNode: step, route: 'again'},
        {
          fromNode: step,
          toNode: node(() => 'end', {name: 'end'}),
          route: 'done',
        },
      ],
    });

    await runToCompletion(wf);

    expect(paths).toEqual([
      'runIds@1/step@1',
      'runIds@1/step@2',
      'runIds@1/step@3',
    ]);
  });

  it('nests node paths through a nested workflow', async () => {
    let innerPath = '';
    const inner = new Workflow({
      name: 'inner',
      edges: [
        [
          START,
          node(
            (ctx: NodeContext) => {
              innerPath = ctx.nodePath;
              return 'inner output';
            },
            {name: 'leaf'},
          ),
        ],
      ],
    });
    const outer = new Workflow({name: 'outer', edges: [[START, inner]]});

    const {ctx} = await runToCompletion(outer);

    expect(innerPath).toBe('outer@1/inner@1/leaf@1');
    expect(ctx.output).toBe('inner output');
  });

  it('keeps a waitForOutput node pending until it produces something', async () => {
    const log: string[] = [];
    let triggers = 0;
    const gate = node(
      () => {
        triggers++;
        return triggers < 2 ? undefined : 'open';
      },
      {name: 'gate', waitForOutput: true},
    );
    const a = recording(log, 'a', 'outA');
    const b = recording(log, 'b', 'outB');
    const wf = new Workflow({
      name: 'gated',
      edges: [
        [START, [a, b]],
        [a, gate],
        [b, gate],
        [gate, recording(log, 'downstream', 'end')],
      ],
    });

    const {ctx} = await runToCompletion(wf);

    expect(triggers).toBe(2);
    expect(log).toEqual(['a', 'b', 'downstream']);
    expect(ctx.output).toBe('end');
  });

  it('suppresses downstream nodes while a waitForOutput node stays pending', async () => {
    const log: string[] = [];
    const gate = node(() => undefined, {name: 'gate', waitForOutput: true});
    const wf = new Workflow({
      name: 'stuck',
      edges: [
        [START, gate],
        [gate, recording(log, 'downstream', 'end')],
      ],
    });

    const {ctx} = await runToCompletion(wf);

    expect(log).toEqual([]);
    expect(ctx.output).toBeUndefined();
  });

  it('rejects two terminal nodes producing output', async () => {
    const wf = new Workflow({
      name: 'twoOutputs',
      edges: [
        [
          START,
          [node(() => 'one', {name: 'a'}), node(() => 'two', {name: 'b'})],
        ],
      ],
    });

    await expect(runToCompletion(wf)).rejects.toThrow(
      'Workflow twoOutputs: multiple terminal nodes produced output (2).',
    );
  });

  it('leaves the output unset when no terminal node produced one', async () => {
    const wf = new Workflow({
      name: 'silent',
      edges: [[START, node(() => undefined, {name: 'quiet'})]],
    });

    const {ctx} = await runToCompletion(wf);

    expect(ctx.output).toBeUndefined();
  });

  it('stops with the first error and does not schedule later nodes', async () => {
    const log: string[] = [];
    const wf = new Workflow({
      name: 'failing',
      edges: [
        [
          START,
          node(
            () => {
              throw new Error('Fail');
            },
            {name: 'boom'},
          ),
          recording(log, 'never', 'x'),
        ],
      ],
    });

    await expect(runToCompletion(wf)).rejects.toThrow('Fail');
    expect(log).toEqual([]);
  });

  it('is unbounded by default', async () => {
    const wf = new Workflow({
      name: 'unbounded',
      edges: [[START, node(() => 'x', {name: 'only'})]],
    });

    expect(wf.maxSteps).toBe(Number.MAX_SAFE_INTEGER);
    await expect(runToCompletion(wf)).resolves.toBeDefined();
  });

  it('gives up once maxSteps node runs have happened', async () => {
    const step = node(
      (ctx: NodeContext) => {
        ctx.route = 'again';
      },
      {name: 'step'},
    );
    const wf = new Workflow({
      name: 'runaway',
      maxSteps: 3,
      edges: [[START, step], {fromNode: step, toNode: step, route: 'again'}],
    });

    await expect(runToCompletion(wf)).rejects.toThrow(
      'Workflow runaway: exceeded maxSteps (3).',
    );
  });

  it('stops scheduling when the invocation is aborted', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const first = node(
      () => {
        log.push('first');
        controller.abort();
        return 'stop here';
      },
      {name: 'first'},
    );
    const wf = new Workflow({
      name: 'aborted',
      edges: [[START, first, recording(log, 'second', 'end')]],
    });

    const {ctx} = await runToCompletion(
      wf,
      undefined,
      makeInvocationContext({abortSignal: controller.signal}),
    );

    expect(log).toEqual(['first']);
    expect(ctx.output).toBeUndefined();
  });

  it('shares session state between nodes', async () => {
    const writer = node(
      (ctx: NodeContext) => {
        ctx.state.set('token', 'abc');
      },
      {name: 'writer'},
    );
    const reader = node((ctx: NodeContext) => ctx.state.get<string>('token'), {
      name: 'reader',
    });
    const wf = new Workflow({
      name: 'shareState',
      edges: [[START, writer, reader]],
    });

    const {ctx} = await runToCompletion(wf);

    expect(ctx.output).toBe('abc');
  });
});
