/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  node,
  NodeContext,
  NodeTimeoutError,
  START,
  Workflow,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {runToCompletion} from './workflow_test_utils.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('node timeouts', () => {
  it('lets a node that finishes in time complete', async () => {
    const quick = node(
      async () => {
        await sleep(1);
        return 'in time';
      },
      {name: 'quick', timeoutMs: 1000},
    );

    const {ctx} = await runToCompletion(quick);

    expect(ctx.output).toBe('in time');
  });

  it('throws NodeTimeoutError naming the node that ran too long', async () => {
    const slow = node(() => sleep(1000), {name: 'slow', timeoutMs: 10});

    const error = await runToCompletion(slow).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NodeTimeoutError);
    expect(error).toMatchObject({
      nodeName: 'slow',
      timeoutMs: 10,
      message: "Node 'slow' timed out after 10 ms.",
    });
  });

  it('streams the events of a node that has a timeout', async () => {
    const streaming = node(
      async function* (ctx: NodeContext): AsyncGenerator<Event, void, void> {
        yield createEvent({
          author: 'streaming',
          content: {parts: [{text: 'progress'}]},
        });
        await sleep(1);
        ctx.output = 'streamed';
      },
      {name: 'streaming', timeoutMs: 1000},
    );

    const {events, ctx} = await runToCompletion(streaming);

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual(['progress']);
    expect(ctx.output).toBe('streamed');
  });

  it('applies no limit when timeoutMs is not set', async () => {
    const slow = node(
      async () => {
        await sleep(30);
        return 'eventually';
      },
      {name: 'slow'},
    );

    const {ctx} = await runToCompletion(slow);

    expect(ctx.output).toBe('eventually');
  });

  it('aborts the node context signal when the timeout fires', async () => {
    let observed: AbortSignal | undefined;
    const slow = node(
      async (ctx: NodeContext) => {
        observed = ctx.abortSignal;
        await sleep(1000);
      },
      {name: 'slow', timeoutMs: 10},
    );

    await expect(runToCompletion(slow)).rejects.toThrow(NodeTimeoutError);

    expect(observed?.aborted).toBe(true);
  });

  it('retries a timed-out node and succeeds on the next attempt', async () => {
    let calls = 0;
    const slowThenFast = node(
      async () => {
        calls++;
        if (calls === 1) {
          await sleep(1000);
        }
        return 'second time';
      },
      {
        name: 'slowThenFast',
        timeoutMs: 20,
        retryConfig: {maxAttempts: 2, initialDelayMs: 0, jitter: 0},
      },
    );

    const {ctx} = await runToCompletion(slowThenFast);

    expect(calls).toBe(2);
    expect(ctx.output).toBe('second time');
  });

  it('leaves no pending timer behind after a completed run', async () => {
    vi.useFakeTimers();
    const quick = node(() => 'done', {name: 'quick', timeoutMs: 1000});

    await runToCompletion(quick);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces the timeout even when the abandoned node later rejects', async () => {
    const lateFailure = node(
      async () => {
        await sleep(20);
        throw new Error('too late to matter');
      },
      {name: 'lateFailure', timeoutMs: 5},
    );

    await expect(runToCompletion(lateFailure)).rejects.toThrow(
      NodeTimeoutError,
    );
    // Give the abandoned attempt time to reject; an unobserved rejection here
    // would fail the run.
    await sleep(40);
  });

  it('reports the inner workflow when a nested workflow times out', async () => {
    const inner = new Workflow({
      name: 'inner',
      edges: [[START, node(() => sleep(1000), {name: 'slow'})]],
      timeoutMs: 10,
    });
    const outer = new Workflow({name: 'outer', edges: [[START, inner]]});

    const error = await runToCompletion(outer).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NodeTimeoutError);
    expect(error).toMatchObject({nodeName: 'inner'});
  });
});
