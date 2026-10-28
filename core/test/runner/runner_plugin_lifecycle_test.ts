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
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  Runner,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {InvocationAbortedError} from '../../src/workflow/errors.js';

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
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

afterEach(() => vi.restoreAllMocks());

describe.each(['runAsync', 'runLive'] as const)(
  '%s plugin lifecycle edge cases',
  (mode) => {
    it.each([
      'complete',
      'abort',
      'abort-before',
      'abort-event',
      'break',
      'return',
      'error',
    ] as const)('releases invocation state after %s', async (outcome) => {
      const active = new Set<string>();
      const calls: string[] = [];
      const failure = new Error('agent failure');
      const h = await setupLifecycle(
        mode,
        new LifecycleAgent(async function* (ctx) {
          yield* oneEvent(ctx);
          if (outcome === 'error') throw failure;
        }),
      );
      h.plugin.beforeRunCallback.mockImplementation(
        async ({invocationContext}) => {
          calls.push('before');
          active.add(invocationContext.invocationId);
          if (outcome === 'abort-before') h.controller.abort();
          return undefined;
        },
      );
      h.plugin.afterRunCallback.mockImplementation(
        async ({invocationContext}) => {
          calls.push('after');
          active.delete(invocationContext.invocationId);
        },
      );
      h.plugin.onAgentErrorCallback.mockImplementation(async () => {
        calls.push('agent-error');
      });
      h.plugin.onRunErrorCallback.mockImplementation(
        async ({invocationContext}) => {
          calls.push('run-error');
          active.delete(invocationContext.invocationId);
        },
      );
      vi.spyOn(h.plugin, 'onEventCallback').mockImplementation(
        async ({event}) => {
          if (outcome === 'abort-event' && event.author === 'agent')
            h.controller.abort();
          return undefined;
        },
      );
      let yielded = 0;
      const consume = async () => {
        if (outcome === 'return') {
          expect((await h.stream.next()).done).toBe(false);
          yielded++;
          await h.stream.return();
        } else {
          for await (const _event of h.stream) {
            yielded++;
            if (outcome === 'break') break;
            if (outcome === 'abort') h.controller.abort();
          }
        }
      };
      if (outcome === 'error') await expect(consume()).rejects.toBe(failure);
      else await consume();
      if (outcome !== 'abort-before' && outcome !== 'abort-event')
        expect(yielded).toBeGreaterThan(0);
      expect(calls).toEqual(
        outcome === 'error'
          ? ['before', 'agent-error', 'run-error']
          : ['before', 'after'],
      );
      expect(active.size).toBe(0);
    });

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
          for await (const _event of h.stream) {
            break;
          }
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
        for (const [args] of h.plugin.onAgentErrorCallback.mock.calls) {
          expect(args.error).toBe(failure);
        }
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
  await expect(collect(h.stream)).rejects.toBe(failure);
  expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
  expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error).toBe(failure);
  expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
  expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
});

describe.each(['runAsync', 'runLive'] as const)(
  '%s thrown cancellation',
  (mode) => {
    it.each([
      'default',
      'AbortError',
      'reason-error',
      'reason-object',
      'reason-string',
      'reason-null',
      'reason-zero',
      'reason-false',
      'reason-empty',
      'wrapped',
      'InvocationAbortedError',
    ] as const)(
      'finalizes %s cancellation without error notifications',
      async (kind) => {
        let cancellation: unknown;
        const agent = new LifecycleAgent(async function* (ctx) {
          yield* oneEvent(ctx);
          if (kind === 'default') h.controller.abort();
          else if (kind === 'reason-error')
            h.controller.abort(new Error('cancelled'));
          else if (kind === 'reason-object')
            h.controller.abort({cancelled: true});
          else if (kind === 'reason-string') h.controller.abort('cancelled');
          else if (kind === 'reason-null') h.controller.abort(null);
          else if (kind === 'reason-zero') h.controller.abort(0);
          else if (kind === 'reason-false') h.controller.abort(false);
          else if (kind === 'reason-empty') h.controller.abort('');
          else h.controller.abort();
          cancellation =
            kind === 'AbortError'
              ? new DOMException('cancelled', 'AbortError')
              : kind === 'InvocationAbortedError'
                ? new InvocationAbortedError('cancelled')
                : kind === 'wrapped'
                  ? new Error('wrapped cancellation', {
                      cause: h.controller.signal.reason,
                    })
                  : h.controller.signal.reason;
          throw cancellation;
        });
        const h = await setupLifecycle(mode, agent);
        const order: string[] = [];
        vi.spyOn(h.plugin, 'onEventCallback').mockImplementation(
          async ({event}) => {
            if (event.errorCode === 'INVOCATION_ABORTED') order.push('sealed');
            return undefined;
          },
        );
        h.plugin.afterRunCallback.mockImplementation(async () => {
          order.push('after');
        });
        const result = await collect(h.stream).then(
          () => ({failed: false}),
          (error: unknown) => ({failed: true, error}),
        );
        expect(result).toEqual({failed: true, error: cancellation});
        expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
        expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
        expect(order).toEqual(
          mode === 'runAsync' ? ['sealed', 'after'] : ['after'],
        );
      },
    );

    it.each(['before-run', 'before-agent', 'after-agent', 'event'] as const)(
      'finalizes cancellation from %s, including plugin wrappers',
      async (stage) => {
        const cancellation = new DOMException('cancelled', 'AbortError');
        const cancel = () => {
          h.controller.abort();
          throw cancellation;
        };
        const config =
          stage === 'before-agent'
            ? {beforeAgentCallback: cancel}
            : stage === 'after-agent'
              ? {afterAgentCallback: cancel}
              : {};
        const h = await setupLifecycle(
          mode,
          new LifecycleAgent(oneEvent, config),
        );
        if (stage === 'before-run')
          h.plugin.beforeRunCallback.mockImplementation(async () => cancel());
        else if (stage === 'event')
          vi.spyOn(h.plugin, 'onEventCallback').mockImplementation(
            async ({event}) => {
              if (event.errorCode !== 'INVOCATION_ABORTED') cancel();
              return undefined;
            },
          );
        const error = await collect(h.stream).catch((error: unknown) => error);
        expect(
          stage === 'before-run' || stage === 'event'
            ? (error as Error).cause
            : error,
        ).toBe(cancellation);
        expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
        expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
      },
    );

    it.each(['unrelated-after-abort', 'AbortError-without-abort'] as const)(
      'continues to report %s as failure',
      async (kind) => {
        const failure =
          kind === 'AbortError-without-abort'
            ? new DOMException('failed', 'AbortError')
            : new Error('unrelated failure');
        const agent = new LifecycleAgent(async function* (ctx) {
          yield* oneEvent(ctx);
          if (kind === 'unrelated-after-abort') h.controller.abort();
          throw failure;
        });
        const h = await setupLifecycle(mode, agent);
        await expect(collect(h.stream)).rejects.toBe(failure);
        expect(h.plugin.afterRunCallback).not.toHaveBeenCalled();
        expect(h.plugin.onAgentErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onAgentErrorCallback.mock.calls[0][0].error).toBe(
          failure,
        );
        expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
        expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error).toBe(
          failure,
        );
      },
    );

    it('preserves cancellation when completion throws', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});

      const cancellation = new DOMException('cancelled', 'AbortError');
      const agent = new LifecycleAgent(async function* (ctx) {
        yield* oneEvent(ctx);
        h.controller.abort(cancellation);
        throw cancellation;
      });
      const h = await setupLifecycle(mode, agent);
      const completionFailure = new Error('completion failure');
      h.plugin.afterRunCallback.mockRejectedValue(completionFailure);
      await expect(collect(h.stream)).rejects.toBe(cancellation);
      expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
      expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
      expect(h.plugin.onRunErrorCallback).toHaveBeenCalledTimes(1);
      expect(h.plugin.onRunErrorCallback.mock.calls[0][0].error.cause).toBe(
        completionFailure,
      );
    });
  },
);

it.each(['cooperative', 'deadline'] as const)(
  'finalizes %s workflow cancellation without inventing agent errors',
  async (kind) => {
    const cancellation = new DOMException('cancelled', 'AbortError');
    class CancellingNode extends BaseNode {
      protected override async *runImpl() {
        yield* [];
        h.controller.abort(cancellation);
        throw cancellation;
      }
    }
    const h = await setupLifecycle(
      'runAsync',
      new CancellingNode({
        name: 'node',
        ...(kind === 'deadline' ? {timeout: 60} : {}),
      }),
    );
    const error = await collect(h.stream).catch((error: unknown) => error);
    if (kind === 'cooperative') {
      expect(error).toBe(cancellation);
    } else {
      expect(error).toBeInstanceOf(InvocationAbortedError);
      expect((error as Error).message).toBe(
        "Invocation aborted while running node 'node'.",
      );
    }
    expect(h.plugin.afterRunCallback).toHaveBeenCalledTimes(1);
    expect(h.plugin.onAgentErrorCallback).not.toHaveBeenCalled();
    expect(h.plugin.onRunErrorCallback).not.toHaveBeenCalled();
  },
);
