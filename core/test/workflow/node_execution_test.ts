/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {createEvent, Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {
  isInvocationAbortedError,
  isNodeTimeoutError,
} from '../../src/workflow/errors.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {executeChildNode} from '../../src/workflow/node_runner.js';
import {createIc, driveNode, FnNode} from './test_helpers.js';

// --- Tests ----------------------------------------------------------------

describe('Phase 1 — node execution & the push/pull bridge', () => {
  it('streams a node event and returns its output', async () => {
    const node = new FnNode('greet', (_ctx, input) => `hello ${input}`);
    const {events, output} = await driveNode(node, 'world');

    expect(output).toBe('hello world');
    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('greet');
    expect(events[0].output).toBe('hello world');
    expect(events[0].nodeInfo?.path).toBe('greet');
  });

  it('passes through an explicitly emitted Event and preserves route', async () => {
    const node = new FnNode('router', () =>
      createEvent({route: 'question', output: 'q'}),
    );
    const {events, output, ctx} = await driveNode(node, 'in');

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('question');
    expect(output).toBe('q');
    expect(ctx.route).toBe('question');
    // Engine stamps provenance without clobbering.
    expect(events[0].nodeInfo?.path).toBe('router');
    expect(events[0].author).toBe('router');
  });

  it('supports nested ctx.runNode() with correct node paths (the bridge)', async () => {
    const inner = new FnNode('inner', (_ctx, input) => `inner(${input})`);
    const outer = new FnNode('outer', async (ctx, input) => {
      const child = await ctx.runNode(inner, input);
      return `outer[${child.output}]`;
    });

    const {events, output} = await driveNode(outer, 'x');

    expect(output).toBe('outer[inner(x)]');
    // Both the child and parent events streamed out, child first.
    const paths = events.map((e) => e.nodeInfo?.path);
    expect(paths).toContain('outer.inner');
    expect(paths).toContain('outer');
    expect(paths.indexOf('outer.inner')).toBeLessThan(paths.indexOf('outer'));
  });

  it('derives nested sub-branches as dotted paths', async () => {
    let innerBranch: string | undefined = 'UNSET';
    const inner = new FnNode('inner', (ctx) => {
      innerBranch = ctx.branch;
      return 'ok';
    });
    const mid = new FnNode('mid', async (ctx, input) => {
      await ctx.runNode(inner, input, {useSubBranch: true});
      return 'm';
    });
    const outer = new FnNode('outer', async (ctx, input) => {
      await ctx.runNode(mid, input, {useSubBranch: true});
      return 'o';
    });

    // outer runs at the root (branch undefined); mid -> 'mid'; inner -> 'mid.inner'.
    await driveNode(outer, 'x');
    expect(innerBranch).toBe('mid.inner');
  });

  it('accumulates ctx.state writes into the event action state delta', async () => {
    const node = new FnNode('writer', (ctx) => {
      ctx.state.set('counter', 7);
      return 'wrote';
    });
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
    });
    // executeChildNode returns the concrete child NodeContext (runNode's return
    // type widens to NodeContext | NodeResult for the resume fast-forward case).
    const child = await executeChildNode({
      parent: root,
      node,
      input: undefined,
      options: {useAsOutput: true},
    });
    expect(child.state.get('counter')).toBe(7);
    expect(child.actions.stateDelta['counter']).toBe(7);
  });

  it('retries a flaky node per retryConfig and then succeeds', async () => {
    let attempts = 0;
    const flaky = new FnNode(
      'flaky',
      () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient');
        }
        return 'ok-after-retry';
      },
      {
        retryConfig: {
          maxAttempts: 3,
          initialDelay: 0.001,
          backoffFactor: 1,
          jitter: 0,
        },
      },
    );

    const {output} = await driveNode(flaky, 'x');
    expect(attempts).toBe(3);
    expect(output).toBe('ok-after-retry');
  });

  it('propagates the final error when retries are exhausted', async () => {
    let attempts = 0;
    const doomed = new FnNode(
      'doomed',
      () => {
        attempts++;
        throw new Error('always fails');
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0.001, jitter: 0}},
    );

    await expect(driveNode(doomed, 'x')).rejects.toThrow('always fails');
    expect(attempts).toBe(2);
  });

  it('clears a failed attempt state writes before retrying', async () => {
    let attempts = 0;
    const node = new FnNode(
      'writer',
      (ctx) => {
        attempts++;
        // Each attempt writes a per-attempt key, then the first attempt fails.
        ctx.state.set(`attempt-${attempts}`, attempts);
        if (attempts < 2) {
          throw new Error('transient');
        }
        return 'ok';
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0.001, jitter: 0}},
    );

    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
    });
    const child = await executeChildNode({
      parent: root,
      node,
      input: 'x',
      options: {useAsOutput: true},
    });

    expect(child.output).toBe('ok');
    // The failed first attempt's write must not survive into the committed
    // delta — only the successful attempt's write remains.
    expect(child.actions.stateDelta).toEqual({'attempt-2': 2});
  });

  it('enforces a per-node timeout with NodeTimeoutError', async () => {
    const slow = new FnNode(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
      {timeout: 0.02},
    );

    const err = await driveNode(slow, 'x').then(
      () => undefined,
      (e) => e,
    );
    expect(isNodeTimeoutError(err)).toBe(true);
  });

  it('cancels a timed-out node: aborts the signal and drops post-deadline events', async () => {
    let captured: AbortSignal | undefined;
    class SlowStream extends BaseNode {
      protected async *runImpl(ctx: NodeContext) {
        captured = ctx.abortSignal;
        yield createEvent({
          author: 'slow',
          content: {role: 'model', parts: [{text: 'early'}]},
        });
        // Cooperative wait that ends on abort; well past the 20ms timeout.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 500);
          ctx.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            {once: true},
          );
        });
        yield createEvent({
          author: 'slow',
          content: {role: 'model', parts: [{text: 'late'}]},
          output: 'late',
        });
      }
    }
    const slow = new SlowStream({name: 'slow', timeout: 0.02});

    // Custom harness: capture events even though the run rejects.
    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
    });
    const seen: string[] = [];
    const orchestration = root.runNode(slow, 'x').then(
      () => channel.close(),
      (err) => channel.fail(err),
    );
    let thrown: unknown;
    try {
      for await (const ev of channel) {
        seen.push(ev.content?.parts?.[0]?.text ?? '');
      }
    } catch (err) {
      thrown = err;
    }
    await orchestration.catch(() => {});

    expect(isNodeTimeoutError(thrown)).toBe(true);
    expect(seen).toContain('early');
    expect(seen).not.toContain('late'); // produced after the deadline -> dropped
    expect(captured?.aborted).toBe(true); // signal fired for cooperative cancel
  });

  it('reports an external abort on a timeout-bearing node as an abort', async () => {
    const controller = new AbortController();
    const node = new FnNode(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
      {timeout: 10},
    );
    setTimeout(() => controller.abort(), 10);

    const err = await driveNode(
      node,
      'x',
      createIc({}, controller.signal),
    ).then(
      () => undefined,
      (e) => e,
    );

    expect(isInvocationAbortedError(err)).toBe(true);
    expect(isNodeTimeoutError(err)).toBe(false);
  });

  it('does not spend a retry attempt on an external abort', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const node = new FnNode(
      'slow',
      () => {
        attempts++;
        return new Promise((resolve) => setTimeout(() => resolve('late'), 500));
      },
      {
        timeout: 10,
        retryConfig: {maxAttempts: 3, initialDelay: 0, jitter: 0},
      },
    );
    setTimeout(() => controller.abort(), 10);

    const err = await driveNode(
      node,
      'x',
      createIc({}, controller.signal),
    ).then(
      () => undefined,
      (e) => e,
    );

    expect(isInvocationAbortedError(err)).toBe(true);
    // Attributed to the run, not laundered through the retry backoff's own
    // abort, which would mean the attempt was booked before anyone noticed.
    expect((err as Error).message).toContain("node 'slow'");
    expect(attempts).toBe(1);
  });

  it('still reports a fired deadline as a timeout when a signal is present', async () => {
    const controller = new AbortController();
    const node = new FnNode(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)),
      {timeout: 0.02},
    );

    const err = await driveNode(
      node,
      'x',
      createIc({}, controller.signal),
    ).then(
      () => undefined,
      (e) => e,
    );

    expect(isNodeTimeoutError(err)).toBe(true);
  });
});

describe('output schema validation (Zod v3 / Zod v4 / genai Schema)', () => {
  it('validates output against a Zod v4 schema', async () => {
    const node = new FnNode('n', () => ({count: 1}), {
      outputSchema: z4.object({count: z4.number()}),
    });
    const {output} = await driveNode(node);
    expect(output).toEqual({count: 1});
  });

  it('rejects output that fails a Zod v4 schema', async () => {
    const node = new FnNode('n', () => ({count: 'nope'}), {
      outputSchema: z4.object({count: z4.number()}),
    });
    await expect(driveNode(node)).rejects.toThrow();
  });

  it('validates output against a Zod v3 schema', async () => {
    const node = new FnNode('n', () => ({count: 2}), {
      outputSchema: z3.object({count: z3.number()}),
    });
    const {output} = await driveNode(node);
    expect(output).toEqual({count: 2});
  });

  it('rejects output that fails a Zod v3 schema', async () => {
    const node = new FnNode('n', () => ({count: 'nope'}), {
      outputSchema: z3.object({count: z3.number()}),
    });
    await expect(driveNode(node)).rejects.toThrow();
  });

  it('validates output against a genai Schema', async () => {
    const node = new FnNode('n', () => ({count: 3}), {
      outputSchema: {
        type: Type.OBJECT,
        properties: {count: {type: Type.NUMBER}},
        required: ['count'],
      },
    });
    const {output} = await driveNode(node);
    expect(output).toEqual({count: 3});
  });

  it('rejects output that fails a genai Schema', async () => {
    const node = new FnNode('n', () => ({anything: 'goes'}), {
      outputSchema: {
        type: Type.OBJECT,
        properties: {count: {type: Type.NUMBER}},
        // `required` is what makes this prove enforcement: an object schema
        // without it accepts any object, since Zod keeps unknown keys.
        required: ['count'],
      },
    });
    await expect(driveNode(node)).rejects.toThrow();
  });
});

describe('input schema validation', () => {
  it('validates input against a Zod v4 schema', async () => {
    const node = new FnNode('n', (_c, i) => i, {
      inputSchema: z4.object({x: z4.number()}),
    });
    const {output} = await driveNode(node, {x: 1});
    expect(output).toEqual({x: 1});
  });

  it('rejects input that fails the schema', async () => {
    const node = new FnNode('n', (_c, i) => i, {
      inputSchema: z4.object({x: z4.number()}),
    });
    await expect(driveNode(node, {x: 'no'})).rejects.toThrow();
  });

  it('passes genai Content input through without schema validation', async () => {
    const node = new FnNode('n', (_c, i) => i, {
      inputSchema: z4.object({x: z4.number()}),
    });
    const content = {role: 'user', parts: [{text: 'hi'}]};
    // Content bypasses inputSchema even though it would not match it.
    const {output} = await driveNode(node, content);
    expect(output).toEqual(content);
  });
});

describe('retry backoff cancellation', () => {
  it('rejects with InvocationAbortedError when the invocation is aborted', async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted before the backoff delay
    const ic = createIc({}, controller.signal);
    const doomed = new FnNode(
      'doomed',
      () => {
        throw new Error('boom');
      },
      {retryConfig: {maxAttempts: 3, initialDelay: 0.01, jitter: 0}},
    );

    const err = await driveNode(doomed, 'x', ic).then(
      () => undefined,
      (e) => e,
    );
    expect(isInvocationAbortedError(err)).toBe(true);
  });
});

describe('outputFor — which nodes an output answers for', () => {
  it('names the emitting node on its own output event', async () => {
    const node = new FnNode('solo', () => 'done');
    const {events} = await driveNode(node);

    const withOutput = events.filter((e) => e.output !== undefined);
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].nodeInfo?.outputFor).toEqual(['solo']);
  });

  it('names the ancestors that took the output as their own', async () => {
    // `useAsOutput` makes the parent stand in for the child, so the child's one
    // event is the result for both. A resumed run reads this to tell that the
    // parent already has an output, even though no event was authored by it.
    const inner = new FnNode('inner', () => 'value');
    const outer = new FnNode('outer', async (ctx) => {
      await ctx.runNode(inner, null, {useAsOutput: true});
      return undefined;
    });

    const {events} = await driveNode(outer);

    const withOutput = events.filter((e) => e.output !== undefined);
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].nodeInfo?.path).toBe('outer.inner');
    expect(withOutput[0].nodeInfo?.outputFor).toEqual(['outer.inner', 'outer']);
  });

  it('leaves it off an event that carries no output', async () => {
    const node = new FnNode('quiet', (ctx) => {
      ctx.emit(
        createEvent({author: 'quiet', content: {parts: [{text: 'hi'}]}}),
      );
      return undefined;
    });

    const {events} = await driveNode(node);
    const textOnly = events.filter((e) => e.output === undefined);
    expect(textOnly.length).toBeGreaterThan(0);
    for (const event of textOnly) {
      expect(event.nodeInfo?.outputFor).toBeUndefined();
    }
  });
});
