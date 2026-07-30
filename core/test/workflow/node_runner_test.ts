/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  node,
  NodeContext,
  runNode,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// Not part of the public barrel, so it is imported by path.
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';

import {makeInvocationContext, runToCompletion} from './workflow_test_utils.js';

const NO_RETRY_DELAY = {initialDelayMs: 0, jitter: 0};

/** A function node that throws on its first `failures` attempts. */
function flaky(
  name: string,
  failures: number,
  error: () => Error = () => new Error('boom'),
) {
  const attempts: number[] = [];
  const built = node(
    (ctx: NodeContext) => {
      attempts.push(ctx.attemptCount);
      if (attempts.length <= failures) {
        throw error();
      }
      return 'recovered';
    },
    {name, retryConfig: {maxAttempts: 4, ...NO_RETRY_DELAY}},
  );
  return {node: built, attempts};
}

describe('runNode', () => {
  it('returns the finished context with the node output', async () => {
    const {events, ctx} = await runToCompletion(
      node(() => 'done', {name: 'done'}),
    );

    expect(events).toEqual([]);
    expect(ctx.output).toBe('done');
    expect(ctx.nodePath).toBe('done@1');
    expect(ctx.attemptCount).toBe(1);
  });

  it('uses the given run id and parent node path', async () => {
    const run = runNode(
      node(() => 'x', {name: 'child'}),
      {
        invocationContext: makeInvocationContext(),
        runId: '7',
        parentNodePath: 'outer@1',
      },
    );

    const step = await run.next();
    expect(step.done).toBe(true);
    if (step.done) {
      expect(step.value.nodePath).toBe('outer@1/child@7');
    }
  });

  it('streams the events the node emits', async () => {
    const streaming = node(
      async function* (ctx: NodeContext): AsyncGenerator<Event, void, void> {
        yield createEvent({
          author: 'streaming',
          content: {parts: [{text: 'a'}]},
        });
        ctx.output = 'end';
      },
      {name: 'streaming'},
    );

    const {events, ctx} = await runToCompletion(streaming);

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual(['a']);
    expect(ctx.output).toBe('end');
  });

  it('emits one event carrying the state the node wrote', async () => {
    const writer = node(
      (ctx: NodeContext) => {
        ctx.state.set('seen', true);
      },
      {name: 'writer'},
    );

    const {events} = await runToCompletion(writer);

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('writer');
    expect(events[0].actions.stateDelta).toEqual({seen: true});
  });

  it('emits one event carrying the artifacts the node saved', async () => {
    const invocationContext = makeInvocationContext({
      artifactService: new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      ),
    });
    const saver = node(
      async (ctx: NodeContext) => {
        await ctx.saveArtifact('report.txt', {text: 'hello'});
      },
      {name: 'saver'},
    );

    const {events} = await runToCompletion(saver, undefined, invocationContext);

    expect(events).toHaveLength(1);
    expect(events[0].actions.artifactDelta).toEqual({'report.txt': 0});
  });

  it('emits no extra event when the node changed nothing', async () => {
    const {events} = await runToCompletion(node(() => 'x', {name: 'quiet'}));

    expect(events).toEqual([]);
  });

  it('fails immediately when the node has no retry config', async () => {
    const failing = node(
      () => {
        throw new Error('nope');
      },
      {name: 'failing'},
    );

    await expect(runToCompletion(failing)).rejects.toThrow('nope');
  });

  it('emits an error event for every failed attempt', async () => {
    const {node: unstable} = flaky('unstable', 2);

    const {events, ctx} = await runToCompletion(unstable);

    expect(events.map((e) => [e.author, e.errorCode, e.errorMessage])).toEqual([
      ['unstable', 'Error', 'boom'],
      ['unstable', 'Error', 'boom'],
    ]);
    expect(ctx.output).toBe('recovered');
  });

  it('increments the attempt count on the context', async () => {
    const {node: unstable, attempts} = flaky('unstable', 2);

    await runToCompletion(unstable);

    expect(attempts).toEqual([1, 2, 3]);
  });

  it('rethrows once maxAttempts is exhausted', async () => {
    const exhausted = node(
      () => {
        throw new Error('always');
      },
      {name: 'exhausted', retryConfig: {maxAttempts: 2, ...NO_RETRY_DELAY}},
    );

    await expect(runToCompletion(exhausted)).rejects.toThrow('always');
  });

  it('retries with the defaults for an empty retry config', async () => {
    let calls = 0;
    const unstable = node(
      () => {
        calls++;
        if (calls === 1) {
          throw new Error('once');
        }
        return 'ok';
      },
      // maxAttempts defaults to 5; the delay is kept at 0 so the test is fast.
      {name: 'unstable', retryConfig: NO_RETRY_DELAY},
    );

    const {ctx} = await runToCompletion(unstable);

    expect(calls).toBe(2);
    expect(ctx.output).toBe('ok');
  });

  it('does not retry an error outside the configured list', async () => {
    let calls = 0;
    const wrongError = node(
      () => {
        calls++;
        throw new TypeError('wrong kind');
      },
      {
        name: 'wrongError',
        retryConfig: {errors: ['RangeError'], ...NO_RETRY_DELAY},
      },
    );

    await expect(runToCompletion(wrongError)).rejects.toThrow('wrong kind');
    expect(calls).toBe(1);
  });

  it('retries an error listed in the retry config', async () => {
    const {node: unstable, attempts} = flaky(
      'unstable',
      1,
      () => new RangeError('out of range'),
    );

    const {ctx} = await runToCompletion(unstable);

    expect(attempts).toHaveLength(2);
    expect(ctx.output).toBe('recovered');
  });

  it('wraps a thrown non-Error value', async () => {
    const throwsString = node(
      () => {
        throw 'plain string';
      },
      {name: 'throwsString'},
    );

    await expect(runToCompletion(throwsString)).rejects.toThrow('plain string');
  });

  it('aborts the node signal when the parent invocation is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let seenAborted: boolean | undefined;
    const observer = node(
      (ctx: NodeContext) => {
        seenAborted = ctx.abortSignal?.aborted;
      },
      {name: 'observer'},
    );

    await runToCompletion(
      observer,
      undefined,
      makeInvocationContext({abortSignal: controller.signal}),
    );

    expect(seenAborted).toBe(true);
  });

  it('aborts the node signal when the parent invocation aborts mid-run', async () => {
    const controller = new AbortController();
    let seenAborted: boolean | undefined;
    const observer = node(
      async (ctx: NodeContext) => {
        controller.abort();
        await Promise.resolve();
        seenAborted = ctx.abortSignal?.aborted;
      },
      {name: 'observer'},
    );

    await runToCompletion(
      observer,
      undefined,
      makeInvocationContext({abortSignal: controller.signal}),
    );

    expect(seenAborted).toBe(true);
  });

  it('leaves no abort listener behind on the parent signal', async () => {
    const controller = new AbortController();
    const invocationContext = makeInvocationContext({
      abortSignal: controller.signal,
    });
    let observed: AbortSignal | undefined;
    const observer = node(
      (ctx: NodeContext) => {
        observed = ctx.abortSignal;
      },
      {name: 'observer'},
    );

    await runToCompletion(observer, undefined, invocationContext);
    controller.abort();

    // The listener installed for the run was removed, so aborting afterwards
    // no longer reaches the finished run's signal.
    expect(observed?.aborted).toBe(false);
  });
});
