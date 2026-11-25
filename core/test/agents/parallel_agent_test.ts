/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  BasePlugin,
  Event,
  InvocationContext,
  ParallelAgent,
  PluginManager,
  SequentialAgent,
  createEvent,
  createSession,
  isParallelAgent,
} from '@google/adk';
import {context as otelContext, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolveFn: (value: T | PromiseLike<T>) => void = () => {};
  let rejectFn: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function rejectOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

function resolveOnAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), {once: true});
  });
}

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];
  private delay: number;

  constructor(config: BaseAgentConfig, eventsToYield: Event[], delay = 0) {
    super(config);
    this.eventsToYield = eventsToYield;
    this.delay = delay;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));

      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // Not needed for this test
  }
}

describe('ParallelAgent', () => {
  it('should be identified as ParallelAgent', () => {
    const agent = new ParallelAgent({name: 'parallel'});
    expect(isParallelAgent(agent)).toBe(true);
  });

  it('should run sub-agents in parallel and merge events', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    // sub1 takes longer, so sub2 should yield first
    const sub1 = new MockSubAgent({name: 'sub1'}, [event1], 50);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub1, sub2],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const event of parallelAgent.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    // sub2 should be first because it has a shorter delay
    expect(yieldedEvents[0].author).toBe('sub2');
    expect(yieldedEvents[1].author).toBe('sub1');
  });

  it('should create isolated branch context for sub-agents', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event]);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const e of parallelAgent.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].branch).toBe('parallel.sub');
  });

  it('should give descendants of a sub-agent the sub-agent branch', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'one'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'two'}]},
    });
    const event3 = createEvent({
      author: 'sub3',
      content: {role: 'model', parts: [{text: 'three'}]},
    });

    // sub1 is slow, so the sequential branch reports first.
    const sub1 = new MockSubAgent({name: 'sub1'}, [event1], 50);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);
    const sub3 = new MockSubAgent({name: 'sub3'}, [event3]);

    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [sub2, sub3],
    });

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [seq, sub1],
    });

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    const yieldedEvents: Event[] = [];
    for await (const e of parallelAgent.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.map((e) => e.author)).toEqual([
      'sub2',
      'sub3',
      'sub1',
    ]);
    expect(yieldedEvents.map((e) => e.branch)).toEqual([
      'parallel.seq',
      'parallel.seq',
      'parallel.sub1',
    ]);
  });

  it('should respect abort signal', async () => {
    const event = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    // Make it take some time so we can abort
    const sub = new MockSubAgent({name: 'sub'}, [event], 100);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    // Run in background and abort
    const runPromise = (async () => {
      const events: Event[] = [];
      for await (const e of parallelAgent.runAsync(context)) {
        events.push(e);
      }
      return events;
    })();

    controller.abort();

    const yieldedEvents = await runPromise;

    expect(yieldedEvents.length).toBe(0);
  });

  it('should abort after some events are yielded', async () => {
    const event1 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const event2 = createEvent({
      author: 'sub',
      content: {role: 'model', parts: [{text: 'world'}]},
    });

    const sub = new MockSubAgent({name: 'sub'}, [event1, event2], 10);

    const parallelAgent = new ParallelAgent({
      name: 'parallel',
      subAgents: [sub],
    });

    const controller = new AbortController();

    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    const yieldedEvents: Event[] = [];

    const runPromise = (async () => {
      for await (const e of parallelAgent.runAsync(context)) {
        yieldedEvents.push(e);
        controller.abort();
      }
    })();

    await runPromise;

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].content?.parts?.[0]?.text).toBe('hello');
  });

  it('should throw when runLive is called', async () => {
    const parallelAgent = new ParallelAgent({name: 'parallel'});
    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
    });
    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent: parallelAgent,
      session,
      pluginManager: new PluginManager(),
    });

    await expect(parallelAgent.runLive(context).next()).rejects.toThrow(
      'This is not supported yet for ParallelAgent.',
    );
  });

  describe('generator and span cleanup', () => {
    let exporter: InMemorySpanExporter;
    let contextManager: AsyncLocalStorageContextManager;
    let provider: BasicTracerProvider;

    beforeEach(() => {
      trace.disable();
      otelContext.disable();
      exporter = new InMemorySpanExporter();
      contextManager = new AsyncLocalStorageContextManager().enable();
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      otelContext.setGlobalContextManager(contextManager);
      trace.setGlobalTracerProvider(provider);
    });

    afterEach(async () => {
      await provider.shutdown();
      trace.disable();
      otelContext.disable();
      contextManager.disable();
    });

    it('aborts in-flight siblings, closes all sub-agent generators, and ends invoke_agent spans when iteration stops early', async () => {
      let fastCleanedUp = false;
      let slowCleanedUp = false;
      let capturedSlowSignal: AbortSignal | undefined;
      const reportedErrorAgents: string[] = [];

      class RecordingErrorPlugin extends BasePlugin {
        constructor() {
          super('recordingErrorPlugin');
        }

        override async onAgentErrorCallback({
          agent,
        }: {
          agent: BaseAgent;
        }): Promise<undefined> {
          reportedErrorAgents.push(agent.name);
          return undefined;
        }
      }

      class FastSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          try {
            yield createEvent({
              invocationId: ctx.invocationId,
              author: this.name,
              branch: ctx.branch,
              content: {role: 'model', parts: [{text: 'fast first'}]},
            });
            await rejectOnAbort(ctx.abortSignal);
            yield createEvent({
              invocationId: ctx.invocationId,
              author: this.name,
              branch: ctx.branch,
              content: {role: 'model', parts: [{text: 'fast second'}]},
            });
          } finally {
            fastCleanedUp = true;
          }
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      class AbortGatedSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          capturedSlowSignal = ctx.abortSignal;
          try {
            await rejectOnAbort(ctx.abortSignal);
            yield createEvent({
              invocationId: ctx.invocationId,
              author: this.name,
              branch: ctx.branch,
              content: {role: 'model', parts: [{text: 'slow first'}]},
            });
          } finally {
            slowCleanedUp = true;
          }
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      const fastSub = new FastSubAgent({name: 'fastSub'});
      const slowSub = new AbortGatedSubAgent({name: 'slowSub'});
      const parallelAgent = new ParallelAgent({
        name: 'parallelEarlyExit',
        subAgents: [fastSub, slowSub],
      });
      const parentAbortController = new AbortController();

      const context = new InvocationContext({
        invocationId: 'inv-parallel-early',
        agent: parallelAgent,
        session: createSession({
          id: 'sess-parallel-early',
          appName: 'test-app',
          userId: 'user-1',
        }),
        pluginManager: new PluginManager([new RecordingErrorPlugin()]),
        abortSignal: parentAbortController.signal,
      });

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      const yieldedEvents: Event[] = [];
      try {
        for await (const event of parallelAgent.runAsync(context)) {
          yieldedEvents.push(event);
          break;
        }
        await Promise.resolve();
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }

      expect(yieldedEvents).toHaveLength(1);
      expect(yieldedEvents[0].author).toBe('fastSub');
      expect(fastCleanedUp).toBe(true);
      expect(slowCleanedUp).toBe(true);
      expect(capturedSlowSignal?.aborted).toBe(true);
      expect(parentAbortController.signal.aborted).toBe(false);
      expect(reportedErrorAgents).toEqual([]);
      expect(unhandledRejections).toEqual([]);

      const finishedSpanNames = exporter
        .getFinishedSpans()
        .map((span) => span.name);
      expect(finishedSpanNames).toEqual(
        expect.arrayContaining([
          'invoke_agent fastSub',
          'invoke_agent slowSub',
          'invoke_agent parallelEarlyExit',
        ]),
      );
    });

    it('aborts in-flight siblings, closes sub-agent generators, ends spans, and suppresses late rejections when a sub-agent throws', async () => {
      let siblingCleanedUp = false;
      const reportedErrorAgents: string[] = [];
      const customReturnSpy = vi.fn(
        async (): Promise<IteratorResult<Event, void>> => ({
          value: undefined,
          done: true,
        }),
      );

      let startedBranches = 0;
      const allBranchesStarted = createDeferred();
      const markBranchStarted = () => {
        startedBranches += 1;
        if (startedBranches === 4) {
          allBranchesStarted.resolve();
        }
      };

      const primaryFailureGate = createDeferred();
      const lateFailureGate = createDeferred();

      class RecordingErrorPlugin extends BasePlugin {
        constructor() {
          super('recordingErrorPlugin');
        }

        override async onAgentErrorCallback({
          agent,
        }: {
          agent: BaseAgent;
        }): Promise<undefined> {
          reportedErrorAgents.push(agent.name);
          return undefined;
        }
      }

      class PrimaryFailingSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
          markBranchStarted();
          await primaryFailureGate.promise;
          throw new Error('primary sub-agent failure');
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      class LateFailingSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
          markBranchStarted();
          await lateFailureGate.promise;
          throw new Error('late sibling failure');
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      class AbortGatedSiblingSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          markBranchStarted();
          try {
            await rejectOnAbort(ctx.abortSignal);
            yield createEvent({
              invocationId: ctx.invocationId,
              author: this.name,
              branch: ctx.branch,
              content: {role: 'model', parts: [{text: 'sibling event'}]},
            });
          } finally {
            siblingCleanedUp = true;
          }
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      class CustomGeneratorSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }

        override runAsync(
          branchCtx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          let yielded = false;
          const generator: AsyncGenerator<Event, void, void> = {
            next: async () => {
              if (!yielded) {
                yielded = true;
                markBranchStarted();
                await resolveOnAbort(branchCtx.abortSignal);
                return {
                  value: createEvent({
                    author: 'customGenSub',
                    content: {role: 'model', parts: [{text: 'custom'}]},
                  }),
                  done: false,
                };
              }
              return {value: undefined, done: true};
            },
            return: customReturnSpy,
            throw: async (error: unknown) => {
              throw error;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
          return generator;
        }
      }

      const parallelAgent = new ParallelAgent({
        name: 'parallelFailureRoot',
        subAgents: [
          new PrimaryFailingSubAgent({name: 'primaryFailingSub'}),
          new LateFailingSubAgent({name: 'lateFailingSub'}),
          new AbortGatedSiblingSubAgent({name: 'siblingSub'}),
          new CustomGeneratorSubAgent({name: 'customGenSub'}),
        ],
      });

      const context = new InvocationContext({
        invocationId: 'inv-parallel-error',
        agent: parallelAgent,
        session: createSession({
          id: 'sess-parallel-error',
          appName: 'test-app',
          userId: 'user-1',
        }),
        pluginManager: new PluginManager([new RecordingErrorPlugin()]),
      });

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const runPromise = (async () => {
          for await (const _ of parallelAgent.runAsync(context)) {
            // Consumes merged stream until primary sub-agent rejects.
          }
        })();

        await allBranchesStarted.promise;
        primaryFailureGate.resolve();
        lateFailureGate.resolve();

        await expect(runPromise).rejects.toThrow('primary sub-agent failure');
        await Promise.resolve();
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }

      expect(unhandledRejections).toEqual([]);
      expect(siblingCleanedUp).toBe(true);
      expect(reportedErrorAgents).not.toContain('siblingSub');
      expect(reportedErrorAgents).toContain('primaryFailingSub');
      expect(customReturnSpy).toHaveBeenCalledTimes(1);
      expect(customReturnSpy).toHaveBeenCalledWith(undefined);

      const finishedSpanNames = exporter
        .getFinishedSpans()
        .map((span) => span.name);
      expect(finishedSpanNames).toEqual(
        expect.arrayContaining([
          'invoke_agent primaryFailingSub',
          'invoke_agent lateFailingSub',
          'invoke_agent siblingSub',
          'invoke_agent parallelFailureRoot',
        ]),
      );
    });

    it('leaves branch signals unaborted and detaches the parent abort listener on normal completion', async () => {
      let capturedBranchSignal: AbortSignal | undefined;

      class SignalCapturingSubAgent extends BaseAgent {
        protected override async *runAsyncImpl(
          ctx: InvocationContext,
        ): AsyncGenerator<Event, void, void> {
          capturedBranchSignal = ctx.abortSignal;
          yield createEvent({
            invocationId: ctx.invocationId,
            author: this.name,
            branch: ctx.branch,
            content: {role: 'model', parts: [{text: 'done'}]},
          });
        }

        protected override async *runLiveImpl(): AsyncGenerator<
          Event,
          void,
          void
        > {
          yield* [];
        }
      }

      const parallelAgent = new ParallelAgent({
        name: 'parallelCleanFinish',
        subAgents: [new SignalCapturingSubAgent({name: 'cleanSub'})],
      });
      const parentAbortController = new AbortController();
      const context = new InvocationContext({
        invocationId: 'inv-parallel-clean',
        agent: parallelAgent,
        session: createSession({
          id: 'sess-parallel-clean',
          appName: 'test-app',
          userId: 'user-1',
        }),
        pluginManager: new PluginManager(),
        abortSignal: parentAbortController.signal,
      });

      const events: Event[] = [];
      for await (const event of parallelAgent.runAsync(context)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(capturedBranchSignal?.aborted).toBe(false);

      parentAbortController.abort();
      expect(capturedBranchSignal?.aborted).toBe(false);
    });
  });
});
