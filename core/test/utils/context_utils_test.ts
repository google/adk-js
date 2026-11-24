/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Aclosing,
  BaseAgent,
  Event,
  InMemorySessionService,
  InvocationContext,
  PluginManager,
  createEvent,
  createRunConfig,
  isAclosing,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

class StreamingTestAgent extends BaseAgent {
  onFinalize?: () => void;

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    try {
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: 'first-event'}]},
      });
      yield createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: 'second-event'}]},
      });
    } finally {
      this.onFinalize?.();
    }
  }

  protected override async *runLiveImpl(
    _ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

describe('Aclosing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('for await iteration', () => {
    it('yields every item and runs finally on normal exhaustion', async () => {
      let finalized = false;
      async function* numbers(): AsyncGenerator<number, void, void> {
        try {
          yield 1;
          yield 2;
          yield 3;
        } finally {
          finalized = true;
        }
      }

      const collected: number[] = [];
      for await (const value of new Aclosing(numbers())) {
        collected.push(value);
      }

      expect(collected).toEqual([1, 2, 3]);
      expect(finalized).toBe(true);
    });

    it('runs finally immediately when the loop exits via break', async () => {
      let finalized = false;
      async function* numbers(): AsyncGenerator<number, void, void> {
        try {
          yield 1;
          yield 2;
          yield 3;
        } finally {
          finalized = true;
        }
      }

      const collected: number[] = [];
      for await (const value of new Aclosing(numbers())) {
        collected.push(value);
        break;
      }

      expect(collected).toEqual([1]);
      expect(finalized).toBe(true);
    });

    it('runs finally immediately when an enclosing function returns early', async () => {
      let finalized = false;
      async function* numbers(): AsyncGenerator<number, void, void> {
        try {
          yield 10;
          yield 20;
        } finally {
          finalized = true;
        }
      }

      async function takeFirst(): Promise<number | undefined> {
        for await (const value of new Aclosing(numbers())) {
          return value;
        }
        return undefined;
      }

      await expect(takeFirst()).resolves.toBe(10);
      expect(finalized).toBe(true);
    });

    it('runs finally immediately when the loop body throws', async () => {
      let finalized = false;
      async function* numbers(): AsyncGenerator<number, void, void> {
        try {
          yield 1;
          yield 2;
        } finally {
          finalized = true;
        }
      }

      await expect(
        (async () => {
          for await (const value of new Aclosing(numbers())) {
            if (value === 1) {
              throw new Error('consumer failed');
            }
          }
        })(),
      ).rejects.toThrow('consumer failed');

      expect(finalized).toBe(true);
    });

    it('calls return(undefined) on a custom AsyncGenerator when next() rejects', async () => {
      const returnSpy = vi.fn(
        async (): Promise<IteratorResult<number, void>> => ({
          value: undefined,
          done: true,
        }),
      );
      const customGenerator: AsyncGenerator<number, void, void> = {
        next: async () => {
          throw new Error('next failed');
        },
        return: returnSpy,
        throw: async (error: unknown) => {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };

      await expect(
        (async () => {
          for await (const _value of new Aclosing(customGenerator)) {
            // Unreachable because next() rejects.
          }
        })(),
      ).rejects.toThrow('next failed');

      expect(returnSpy).toHaveBeenCalledTimes(1);
      expect(returnSpy).toHaveBeenCalledWith(undefined);
    });

    it('supports generators with non-void return types and AsyncGenerator<number, unknown, unknown>', async () => {
      let stringReturnFinalized = false;
      async function* numbersWithSummary() {
        try {
          yield 1;
          yield 2;
          return 'done';
        } finally {
          stringReturnFinalized = true;
        }
      }

      {
        await using aclosing = new Aclosing(numbersWithSummary());
        const disposable: AsyncDisposable = aclosing;
        expect(isAclosing(disposable)).toBe(true);

        const first = await aclosing.next();
        expect(first).toEqual({value: 1, done: false});
        const second = await aclosing.next();
        expect(second).toEqual({value: 2, done: false});
        const completion = await aclosing.next();
        expect(completion).toEqual({value: 'done', done: true});
      }
      expect(stringReturnFinalized).toBe(true);

      stringReturnFinalized = false;
      {
        await using earlyClosed = new Aclosing(numbersWithSummary());
        const first = await earlyClosed.next();
        expect(first).toEqual({value: 1, done: false});
        expect(stringReturnFinalized).toBe(false);
      }
      expect(stringReturnFinalized).toBe(true);

      let genericFinalized = false;
      const createGenericGenerator = (): AsyncGenerator<
        number,
        unknown,
        unknown
      > =>
        (async function* () {
          try {
            yield 10;
            yield 20;
            return {completed: true};
          } finally {
            genericFinalized = true;
          }
        })();

      const collected: number[] = [];
      const genericWrapped = new Aclosing(createGenericGenerator());
      const narrowedUnion: Aclosing<number, unknown, unknown> | undefined =
        Math.random() >= 0 ? genericWrapped : undefined;
      expect(isAclosing(narrowedUnion)).toBe(true);

      for await (const value of genericWrapped) {
        collected.push(value);
        break;
      }

      expect(collected).toEqual([10]);
      expect(genericFinalized).toBe(true);
    });
  });

  describe('explicit resource management and manual next() stepping', () => {
    const spanExporter = new InMemorySpanExporter();
    const contextManager = new AsyncLocalStorageContextManager();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });

    beforeAll(() => {
      context.setGlobalContextManager(contextManager.enable());
      trace.setGlobalTracerProvider(tracerProvider);
    });

    beforeEach(() => {
      spanExporter.reset();
    });

    afterAll(async () => {
      await tracerProvider.shutdown();
      trace.disable();
      context.disable();
      contextManager.disable();
    });

    it('finalizes a manually stepped generator as soon as await using exits', async () => {
      let finalized = false;
      async function* values(): AsyncGenerator<string, void, number> {
        try {
          const received = yield 'alpha';
          yield `beta-${received}`;
          yield 'gamma';
        } finally {
          finalized = true;
        }
      }

      {
        await using aclosing = new Aclosing(values());
        const first = await aclosing.next();
        expect(first).toEqual({value: 'alpha', done: false});
        const second = await aclosing.next(7);
        expect(second).toEqual({value: 'beta-7', done: false});
        expect(finalized).toBe(false);
      }

      expect(finalized).toBe(true);
    });

    it('closes the active agent invocation span when BaseAgent.runAsync stops early', async () => {
      let finalized = false;
      const agent = new StreamingTestAgent({name: 'streamingAgent'});
      agent.onFinalize = () => {
        finalized = true;
      };

      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: 'test-app',
        userId: 'user-1',
      });
      const invocationContext = new InvocationContext({
        invocationId: 'inv-1',
        agent,
        session,
        sessionService,
        pluginManager: new PluginManager([]),
        runConfig: createRunConfig(),
      });

      {
        await using aclosing = new Aclosing(agent.runAsync(invocationContext));
        const firstStep = await aclosing.next();
        expect(firstStep.done).toBe(false);
        expect(finalized).toBe(false);
        expect(spanExporter.getFinishedSpans()).toHaveLength(0);
      }

      expect(finalized).toBe(true);
      expect(spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
        'invoke_agent streamingAgent',
      ]);
    });

    it('falls back to Symbol.for("Symbol.asyncDispose") when Symbol.asyncDispose is undefined', async () => {
      const originalSymbol = globalThis.Symbol;
      const fallbackSymbol = originalSymbol.for('Symbol.asyncDispose');
      const fakeSymbol = Object.assign(
        (description?: string | number) => originalSymbol(description),
        {
          for: originalSymbol.for.bind(originalSymbol),
          keyFor: originalSymbol.keyFor.bind(originalSymbol),
          iterator: originalSymbol.iterator,
          asyncIterator: originalSymbol.asyncIterator,
        },
      );

      let finalized = false;
      async function* items(): AsyncGenerator<string, void, void> {
        try {
          yield 'one';
          yield 'two';
        } finally {
          finalized = true;
        }
      }

      try {
        vi.stubGlobal('Symbol', fakeSymbol);
        const aclosing = new Aclosing(items());
        const first = await aclosing.next();
        expect(first).toEqual({value: 'one', done: false});
        expect(finalized).toBe(false);

        const disposer: unknown = Reflect.get(aclosing, fallbackSymbol);
        expect(typeof disposer).toBe('function');
        if (typeof disposer === 'function') {
          await disposer.call(aclosing);
        }
      } finally {
        vi.unstubAllGlobals();
      }

      expect(finalized).toBe(true);
    });
  });

  describe('close idempotency and cleanup errors', () => {
    it('invokes generator.return(undefined) at most once across sequential and concurrent close() calls', async () => {
      let resolveReturn: (() => void) | undefined;
      const returnSpy = vi.fn(
        () =>
          new Promise<IteratorResult<number, void>>((resolve) => {
            resolveReturn = () => resolve({value: undefined, done: true});
          }),
      );
      const customGenerator: AsyncGenerator<number, void, void> = {
        next: async () => ({value: 1, done: false}),
        return: returnSpy,
        throw: async (error: unknown) => {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };

      const aclosing = new Aclosing(customGenerator);
      const firstClose = aclosing.close();
      const secondClose = aclosing.close();

      expect(returnSpy).toHaveBeenCalledTimes(1);
      resolveReturn?.();
      await Promise.all([firstClose, secondClose]);

      await aclosing.close();
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates a cleanup rejection directly without SuppressedError inside await using and for await', async () => {
      const cleanupError = new Error('cleanup failed');
      const returnSpy = vi.fn(
        async (): Promise<IteratorResult<number, void>> => {
          throw cleanupError;
        },
      );
      const customGenerator: AsyncGenerator<number, void, void> = {
        next: async () => ({value: 1, done: false}),
        return: returnSpy,
        throw: async (error: unknown) => {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };

      let caught: unknown;
      try {
        await using aclosing = new Aclosing(customGenerator);
        for await (const value of aclosing) {
          if (value === 1) {
            break;
          }
        }
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(cleanupError);
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('isAclosing and constructor validation', () => {
    it('identifies Aclosing instances and narrows union and unknown values', () => {
      async function* numbers(): AsyncGenerator<number, void, void> {
        yield 1;
      }

      const rawGenerator = numbers();
      const wrapped = new Aclosing(rawGenerator);
      const unknownValue: unknown = wrapped;
      const unionValue: Aclosing<number, void> | undefined =
        Math.random() >= 0 ? wrapped : undefined;

      expect(isAclosing(unknownValue)).toBe(true);
      if (isAclosing(unionValue)) {
        expect(unionValue.asyncGenerator).toBe(rawGenerator);
      }

      expect(isAclosing(rawGenerator)).toBe(false);
      expect(isAclosing({})).toBe(false);
      expect(isAclosing(null)).toBe(false);
      expect(isAclosing(undefined)).toBe(false);
      expect(isAclosing('aclosing')).toBe(false);
      expect(isAclosing(42)).toBe(false);
    });

    it.each([
      {label: 'null', invalid: null},
      {label: 'undefined', invalid: undefined},
      {label: 'a string primitive', invalid: 'not-a-generator'},
      {label: 'a number primitive', invalid: 123},
      {label: 'an empty object', invalid: {}},
      {
        label: 'an object missing return()',
        invalid: {next: async () => ({value: undefined, done: true})},
      },
      {
        label: 'an object missing next()',
        invalid: {return: async () => ({value: undefined, done: true})},
      },
    ])('throws TypeError when constructed with $label', ({invalid}) => {
      expect(() => {
        Reflect.construct(Aclosing, [invalid]);
      }).toThrow(TypeError);
    });
  });
});
