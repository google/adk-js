/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  BaseNode,
  BasePlugin,
  Context,
  createEvent,
  Event,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  Runner,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const cases = [
  'complete',
  'abort',
  'abort-before',
  'abort-event',
  'break',
  'return',
  'error',
] as const;

describe.each(['runAsync', 'runLive'] as const)('issue #1132: %s', (mode) => {
  it.each(cases)('%s notifies the recording plugin', async (outcome) => {
    const calls: string[] = [];
    const active = new Set<string>();
    const failure = new Error('scripted agent failure');
    const controller = new AbortController();

    class RecordingPlugin extends BasePlugin {
      override async beforeRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        calls.push('before');
        active.add(invocationContext.invocationId);
        if (outcome === 'abort-before') controller.abort();
        return undefined;
      }

      override async afterRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        calls.push('after');
        active.delete(invocationContext.invocationId);
      }

      override async onAgentErrorCallback() {
        calls.push('agent-error');
      }

      override async onEventCallback({event}: {event: Event}) {
        if (outcome === 'abort-event' && event.author === 'scripted') {
          controller.abort();
        }
        return undefined;
      }

      override async onRunErrorCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        calls.push('run-error');
        active.delete(invocationContext.invocationId);
      }
    }

    class ScriptedAgent extends BaseAgent {
      protected override async *runAsyncImpl(ctx: InvocationContext) {
        yield createEvent({
          invocationId: ctx.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: 'first event'}]},
        });
        if (outcome === 'error') throw failure;
      }

      protected override async *runLiveImpl(ctx: InvocationContext) {
        yield* this.runAsyncImpl(ctx);
      }
    }

    const runner = new InMemoryRunner({
      appName: 'repro',
      agent: new ScriptedAgent({name: 'scripted'}),
      plugins: [new RecordingPlugin('recording')],
    });
    await runner.sessionService.createSession({
      appName: 'repro',
      userId: 'u',
      sessionId: 's',
    });
    const params = {
      userId: 'u',
      sessionId: 's',
      abortSignal: controller.signal,
    };
    const stream =
      mode === 'runAsync'
        ? runner.runAsync({...params, newMessage: {parts: [{text: 'go'}]}})
        : runner.runLive({...params, liveRequestQueue: new LiveRequestQueue()});

    let caught: unknown;
    let yielded = 0;
    try {
      if (outcome === 'return') {
        expect((await stream.next()).done).toBe(false);
        yielded++;
        await stream.return(undefined);
      } else {
        for await (const event of stream) {
          yielded++;
          if (outcome === 'break') break;
          if (outcome === 'abort' && event.author === 'scripted') {
            controller.abort();
          }
        }
      }
    } catch (error) {
      caught = error;
    }

    if (outcome !== 'abort-before' && outcome !== 'abort-event') {
      expect(yielded).toBeGreaterThan(0);
    }
    expect(caught).toBe(outcome === 'error' ? failure : undefined);
    expect(calls).toEqual(
      outcome === 'error'
        ? ['before', 'agent-error', 'run-error']
        : ['before', 'after'],
    );
    expect(active.size).toBe(0);
  });
});

type Mode = 'runAsync' | 'runLive';
type Script = (ctx: InvocationContext) => AsyncGenerator<Event, void, void>;

class LifecycleAgent extends BaseAgent {
  constructor(
    private readonly script: Script = oneEvent,
    config: Partial<BaseAgentConfig> = {},
  ) {
    super({name: 'agent', ...config});
  }
  protected override async *runAsyncImpl(ctx: InvocationContext) {
    yield* this.script(ctx);
  }
  protected override async *runLiveImpl(ctx: InvocationContext) {
    yield* this.script(ctx);
  }
}

async function* oneEvent(ctx: InvocationContext) {
  yield createEvent({
    invocationId: ctx.invocationId,
    author: ctx.agent?.name ?? 'agent',
    content: {role: 'model', parts: [{text: 'hello'}]},
  });
}

class LifecyclePlugin extends BasePlugin {
  override beforeRunCallback = vi.fn<BasePlugin['beforeRunCallback']>(
    async () => undefined,
  );
  override afterRunCallback = vi.fn<BasePlugin['afterRunCallback']>(
    async () => {},
  );
  override onAgentErrorCallback = vi.fn<BasePlugin['onAgentErrorCallback']>(
    async () => {},
  );
  override onRunErrorCallback = vi.fn<BasePlugin['onRunErrorCallback']>(
    async () => {},
  );
}

async function setupLifecycle(
  mode: Mode,
  agent: BaseAgent | BaseNode = new LifecycleAgent(),
) {
  const plugin = new LifecyclePlugin('lifecycle');
  const runner = new Runner({
    sessionService: new InMemorySessionService(),
    appName: 'lifecycle',
    agent,
    plugins: [plugin],
  });
  await runner.sessionService.createSession({
    appName: 'lifecycle',
    userId: 'u',
    sessionId: 's',
  });
  const controller = new AbortController();
  const params = {userId: 'u', sessionId: 's', abortSignal: controller.signal};
  const stream =
    mode === 'runAsync'
      ? runner.runAsync({...params, newMessage: {parts: [{text: 'go'}]}})
      : runner.runLive({...params, liveRequestQueue: new LiveRequestQueue()});
  return {plugin, runner, controller, stream};
}

async function collect(stream: AsyncGenerator<Event, void, void>) {
  const events: Event[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => vi.restoreAllMocks());

describe.each(['runAsync', 'runLive'] as const)(
  '%s plugin lifecycle edge cases',
  (mode) => {
    it.each(['complete', 'close'] as const)(
      'finalizes a before-run response on %s',
      async (termination) => {
        const h = await setupLifecycle(mode);
        h.plugin.beforeRunCallback.mockResolvedValue({
          parts: [{text: 'blocked'}],
        });
        if (termination === 'close') {
          expect((await h.stream.next()).value?.content?.parts?.[0].text).toBe(
            'blocked',
          );
          await h.stream.return();
        } else {
          expect(await collect(h.stream)).toHaveLength(1);
        }
        expect(h.plugin.afterRunCallback).toHaveBeenCalledExactlyOnceWith(
          h.plugin.beforeRunCallback.mock.calls[0][0],
        );
        expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
      },
    );

    it.each(['before', 'event', 'persistence'] as const)(
      'reports a runner %s failure once',
      async (stage) => {
        const h = await setupLifecycle(mode);
        const failure = new Error(stage);
        if (stage === 'before')
          h.plugin.beforeRunCallback.mockRejectedValue(failure);
        if (stage === 'event')
          vi.spyOn(h.plugin, 'onEventCallback').mockRejectedValue(failure);
        if (stage === 'persistence') {
          const append = h.runner.sessionService.appendEvent.bind(
            h.runner.sessionService,
          );
          vi.spyOn(h.runner.sessionService, 'appendEvent').mockImplementation(
            async (params) => {
              if (params.event.author !== 'user') throw failure;
              return append(params);
            },
          );
        }
        const error = await collect(h.stream).catch((e: unknown) => e);
        expect(stage === 'persistence' ? error : (error as Error).cause).toBe(
          failure,
        );
        expect(h.plugin.onRunErrorCallback).toHaveBeenCalledExactlyOnceWith({
          invocationContext:
            h.plugin.beforeRunCallback.mock.calls[0][0].invocationContext,
          error,
        });
        expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
        expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
      },
    );

    it.each(['beforeAgentCallback', 'afterAgentCallback'] as const)(
      'reports %s failures at both levels',
      async (callback) => {
        const failure = new Error(callback);
        const agent = new LifecycleAgent(oneEvent, {
          [callback]: () => {
            throw failure;
          },
        });
        const h = await setupLifecycle(mode, agent);
        await expect(collect(h.stream)).rejects.toBe(failure);
        expect(h.plugin.onAgentErrorCallback).toHaveBeenCalledExactlyOnceWith({
          agent,
          callbackContext: expect.any(Context),
          error: failure,
        });
        expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error).toBe(
          failure,
        );
        expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, null, 0, 'failure'])(
      'preserves the non-Error thrown value %s',
      async (failure) => {
        const h = await setupLifecycle(
          mode,
          new LifecycleAgent(async function* (ctx) {
            yield* oneEvent(ctx);
            throw failure;
          }),
        );
        const result = await collect(h.stream).then(
          () => ({failed: false}),
          (error) => ({failed: true, error}),
        );
        expect(result).toEqual({failed: true, error: failure});
        expect(h.plugin.onAgentErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onAgentErrorCallback.mock.calls[0][0].error.cause).toBe(
          failure,
        );
        expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error.cause).toBe(
          failure,
        );
        expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
      },
    );

    it.each(['complete', 'abort', 'return', 'break'] as const)(
      'handles completion-hook failure during %s',
      async (termination) => {
        vi.spyOn(logger, 'error').mockImplementation(() => {});
        const h = await setupLifecycle(mode);
        const failure = new Error('completion');
        h.plugin.afterRunCallback.mockRejectedValue(failure);
        if (termination === 'abort') {
          h.plugin.beforeRunCallback.mockImplementation(async () => {
            h.controller.abort();
            return undefined;
          });
        }
        if (termination === 'return') {
          await h.stream.next();
          await expect(h.stream.return()).resolves.toEqual({
            done: true,
            value: undefined,
          });
        } else if (termination === 'break') {
          for await (const _event of h.stream) break;
        } else {
          await expect(collect(h.stream)).rejects.toMatchObject({
            cause: failure,
          });
        }
        expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error.cause).toBe(
          failure,
        );
        expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
        await h.stream.return();
        expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
      },
    );

    it.each([false, true])(
      'reports child errors, handled by parent: %s',
      async (handled) => {
        const failure = new Error('child');
        const child = new LifecycleAgent(
          async function* (ctx) {
            yield* oneEvent(ctx);
            throw failure;
          },
          {name: 'child'},
        );
        const parent = new LifecycleAgent(
          async function* (ctx) {
            try {
              yield* child[mode](ctx);
            } catch (error) {
              if (!handled) throw error;
            }
          },
          {name: 'parent', subAgents: [child]},
        );
        const h = await setupLifecycle(mode, parent);
        if (handled) {
          await collect(h.stream);
          expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
          expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
        } else {
          await expect(collect(h.stream)).rejects.toBe(failure);
          expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
          expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
        }
        expect(
          h.plugin.onAgentErrorCallback.mock.calls.map(
            ([args]) => args.agent.name,
          ),
        ).toEqual(handled ? ['child'] : ['child', 'parent']);
        for (const [args] of h.plugin.onAgentErrorCallback.mock.calls)
          expect(args.error).toBe(failure);
      },
    );

    it('does not let failed error dispatch replace the original error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const failure = new Error('agent');
      const h = await setupLifecycle(
        mode,
        new LifecycleAgent(async function* (ctx) {
          yield* oneEvent(ctx);
          throw failure;
        }),
      );
      vi.spyOn(
        h.runner.pluginManager,
        'runOnAgentErrorCallback',
      ).mockRejectedValue(new Error('agent notification'));
      vi.spyOn(
        h.runner.pluginManager,
        'runOnRunErrorCallback',
      ).mockRejectedValue(new Error('run notification'));
      await expect(collect(h.stream)).rejects.toBe(failure);
      expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
    });

    it('does not notify for an unstarted or pre-aborted iterator', async () => {
      const unstarted = await setupLifecycle(mode);
      await unstarted.stream.return();
      const aborted = await setupLifecycle(mode);
      aborted.controller.abort();
      await collect(aborted.stream);
      for (const h of [unstarted, aborted]) {
        expect(h.plugin.beforeRunCallback).not.toHaveBeenCalled();
        expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
        expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
      }
    });

    it('reports an error injected by the consumer without calling completion', async () => {
      const h = await setupLifecycle(mode);
      const failure = new Error('consumer');
      await h.stream.next();
      await expect(h.stream.throw(failure)).rejects.toBe(failure);
      expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
      expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error).toBe(failure);
      expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
    });
  },
);

it('reports workflow-root errors without inventing agent errors', async () => {
  const failure = new Error('node');
  class FailingNode extends BaseNode {
    protected override async *runImpl() {
      yield 'started';
      throw failure;
    }
  }
  const h = await setupLifecycle('runAsync', new FailingNode({name: 'node'}));
  await expect(collect(h.stream)).rejects.toThrow();
  expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
  expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
  expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
});
