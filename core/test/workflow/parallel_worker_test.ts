/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {hasRequestInputFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {buildNode} from '../../src/workflow/utils/workflow_graph_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveNode, replyAgent} from './test_helpers.js';

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
    // Pin both halves: never more than 2, and it actually reached 2 (this would
    // stay green at peak=1 if the pool regressed to running items serially).
    expect(peak).toBe(2);
  });

  it('bounds concurrency by the default when maxParallelWorkers is unset', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FunctionNode('track', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    // 20 items with no explicit limit must not fan out to 20 concurrent runs.
    const {output} = await driveNode(
      new ParallelWorker(inner),
      Array.from({length: 20}, (_v, i) => i),
    );
    expect(output).toHaveLength(20);
    expect(peak).toBe(8); // DEFAULT_MAX_PARALLEL_WORKERS
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

  it('fails (not silently) when an item rejects with undefined', async () => {
    const inner = new FunctionNode('bad', (_c, n: number) => {
      if (n === 2) {
        throw undefined; // bare reject: must still count as a failure
      }
      return n;
    });
    let rejected = false;
    try {
      await driveNode(new ParallelWorker(inner), [1, 2, 3]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('emits no list when an item stops to ask the user', async () => {
    const inner = new FunctionNode('maybeAsk', (_c, n: number) => {
      if (n === 2) {
        return new RequestInput({interruptId: `ask-${n}`, message: 'confirm?'});
      }
      return n * 10;
    });
    const {output} = await driveNode(new ParallelWorker(inner), [1, 2, 3]);
    // Not [10, undefined, 30]: a hole would be indistinguishable from an item
    // that legitimately returned nothing, and the worker would report success.
    expect(output).toBeUndefined();
  });

  it('stops claiming items once one interrupts', async () => {
    const started: number[] = [];
    const inner = new FunctionNode('maybeAsk', (_c, n: number) => {
      started.push(n);
      if (n === 1) {
        return new RequestInput({interruptId: 'ask-1', message: 'confirm?'});
      }
      return n;
    });
    await driveNode(
      new ParallelWorker(inner, {maxParallelWorkers: 1}),
      [1, 2, 3],
    );
    expect(started).toEqual([1]);
  });

  it('stops scheduling items once the invocation is aborted', async () => {
    let calls = 0;
    const inner = new FunctionNode('count', (_c, n: number) => {
      calls++;
      return n;
    });
    const controller = new AbortController();
    controller.abort(); // aborted before the run starts
    const ic = createIc({}, controller.signal);

    const {output} = await driveNode(
      new ParallelWorker(inner),
      [1, 2, 3, 4, 5],
      ic,
    );
    // No item was scheduled, and no wrong partial list was emitted.
    expect(calls).toBe(0);
    expect(output).toBeUndefined();
  });
});

describe('ParallelWorker takes what edges take', () => {
  it('maps a bare function across the list without node()', async () => {
    function double(_c: unknown, n: number) {
      return n * 2;
    }
    const {output} = await driveNode(new ParallelWorker(double), [1, 2, 3]);
    expect(output).toEqual([2, 4, 6]);
  });

  it('names itself after the value, as an edge would name it', () => {
    function double(_c: unknown, n: number) {
      return n * 2;
    }
    expect(new ParallelWorker(double).name).toBe('double');
  });

  it('maps a bare agent across the list, with its reply as each output', async () => {
    const worker = new ParallelWorker(replyAgent('reply'));
    const {output} = await driveNode(worker, [1, 2]);
    expect(output).toEqual(['ok', 'ok']);
  });

  it('reports an unnameable value with the builder’s message', () => {
    expect(() => new ParallelWorker((_c: unknown, n: number) => n)).toThrow(
      /has no name; pass \{name\} explicitly/,
    );
  });

  it('still takes an already-built node, unchanged', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const worker = new ParallelWorker(inner);
    expect(worker.name).toBe('double');
    expect((await driveNode(worker, [1, 2])).output).toEqual([2, 4]);
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

describe('ParallelWorker human-in-the-loop', () => {
  async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
    const out: Event[] = [];
    for await (const e of gen) {
      out.push(e);
    }
    return out;
  }

  it('pauses the fan-out, then completes it with the answer on resume', async () => {
    const runs: number[] = [];
    const inner = new FunctionNode(
      'review',
      (ctx: NodeContext, n: number) => {
        runs.push(n);
        if (n === 2) {
          const answer = ctx.resumeInputs['ask-2'];
          return answer === undefined
            ? new RequestInput({interruptId: 'ask-2', message: 'confirm 2?'})
            : `2:${answer}`;
        }
        return `${n}:auto`;
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'pw_hitl_wf',
      dynamicEntry: async (ctx) => {
        const worker = new ParallelWorker(inner, {maxParallelWorkers: 1});
        const result = await ctx.runNode(worker, [1, 2, 3]);
        return result.output;
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});

    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      }),
    );

    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);
    expect(runs).toEqual([1, 2]);
    // No list yet: emitting one here records a hole for item 2 that the resumed
    // turn would then fast-forward, discarding the answer before it is given.
    expect(turn1.some((e) => Array.isArray(e.output))).toBe(false);

    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'ask-2',
                name: 'adk_request_input',
                response: {result: 'ok'},
              },
            },
          ],
        },
      }),
    );

    // Item 1 is fast-forwarded by run id, item 2 resumes, item 3 runs fresh.
    expect(runs).toEqual([1, 2, 2, 3]);
    expect(turn2.find((e) => Array.isArray(e.output))?.output).toEqual([
      '1:auto',
      '2:ok',
      '3:auto',
    ]);
  });
});
