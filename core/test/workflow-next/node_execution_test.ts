/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {BaseNode} from '../../src/workflow-next/base_node.js';
import {NodeTimeoutError} from '../../src/workflow-next/errors.js';
import {NodeContext} from '../../src/workflow-next/node_context.js';
import {EventChannel} from '../../src/workflow-next/utils/event_channel.js';

// --- Test harness ---------------------------------------------------------

function createIc(params?: Partial<InvocationContext>): InvocationContext {
  const session: Session = {
    id: 'session-123',
    appName: 'test-app',
    userId: 'test-user',
    events: [],
    state: {},
    lastUpdateTime: Date.now(),
  } as unknown as Session;

  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: {
      name: 'wf',
      runAsync: async function* () {},
    } as unknown as BaseAgent,
    pluginManager: new PluginManager(),
    ...params,
  });
}

/**
 * Drives a root node the way the Phase 2 Workflow loop will: orchestration
 * pushes events into the channel concurrently while the consumer drains it.
 * This exercises the real push/pull bridge, not a buffer-then-read shortcut.
 */
async function driveRoot(
  ic: InvocationContext,
  node: BaseNode,
  input?: unknown,
): Promise<{events: Event[]; output: unknown; route: unknown}> {
  const channel = new EventChannel<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });

  const events: Event[] = [];
  const orchestration = root.runNode(node, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );

  for await (const ev of channel) {
    events.push(ev);
  }
  await orchestration;
  return {events, output: root.output, route: root.route};
}

// A minimal node that yields whatever its function returns (value | Event).
class FnNode extends BaseNode {
  constructor(
    name: string,
    private readonly fn: (
      ctx: NodeContext,
      input: unknown,
    ) => unknown | Promise<unknown>,
    config?: Partial<
      Omit<
        import('../../src/workflow-next/base_node.js').BaseNodeConfig,
        'name'
      >
    >,
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}

// --- Tests ----------------------------------------------------------------

describe('Phase 1 — node execution & the push/pull bridge', () => {
  it('streams a node event and returns its output', async () => {
    const node = new FnNode('greet', (_ctx, input) => `hello ${input}`);
    const {events, output} = await driveRoot(createIc(), node, 'world');

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
    const {events, output, route} = await driveRoot(createIc(), node, 'in');

    expect(events).toHaveLength(1);
    expect(events[0].route).toBe('question');
    expect(output).toBe('q');
    expect(route).toBe('question');
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

    const {events, output} = await driveRoot(createIc(), outer, 'x');

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
    await driveRoot(createIc(), outer, 'x');
    expect(innerBranch).toBe('mid.inner');
  });

  it('accumulates ctx.state writes into the event action state delta', async () => {
    const node = new FnNode('writer', (ctx) => {
      ctx.state.set('counter', 7);
      return 'wrote';
    });
    const channel = new EventChannel<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
    });
    const child = await root.runNode(node, undefined, {useAsOutput: true});
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

    const {output} = await driveRoot(createIc(), flaky, 'x');
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

    await expect(driveRoot(createIc(), doomed, 'x')).rejects.toThrow(
      'always fails',
    );
    expect(attempts).toBe(2);
  });

  it('enforces a per-node timeout with NodeTimeoutError', async () => {
    const slow = new FnNode(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
      {timeout: 0.02},
    );

    await expect(driveRoot(createIc(), slow, 'x')).rejects.toBeInstanceOf(
      NodeTimeoutError,
    );
  });
});
