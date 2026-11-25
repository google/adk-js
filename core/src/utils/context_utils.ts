/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
  interface Disposable {
    [Symbol.dispose](): void;
  }
  interface AsyncDisposable {
    [Symbol.asyncDispose](): PromiseLike<void>;
  }
}

const ACLOSING_SIGNATURE_SYMBOL = Symbol.for('google.adk.aclosing');

/**
 * Checks whether an object is an instance of {@link Aclosing}.
 *
 * @param obj The value to check.
 * @returns True if `obj` is an {@link Aclosing} wrapper, false otherwise.
 */
export function isAclosing(
  obj: unknown,
): obj is Aclosing<unknown, unknown, never> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    ACLOSING_SIGNATURE_SYMBOL in obj &&
    obj[ACLOSING_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Wraps an `AsyncGenerator` so its cleanup (`return(undefined)`) is awaited
 * deterministically on early exit, manual `next()` stepping with `await using`,
 * or `next()` rejection.
 */
export class Aclosing<T = unknown, TReturn = unknown, TNext = unknown>
  implements AsyncIterable<T>, AsyncDisposable
{
  /**
   * Signature symbol identifying {@link Aclosing} instances across package
   * copies.
   */
  readonly [ACLOSING_SIGNATURE_SYMBOL] = true;

  /**
   * The underlying async generator managed by this wrapper.
   */
  readonly asyncGenerator: AsyncGenerator<T, TReturn, TNext>;

  /**
   * Disposes the wrapped async generator by calling {@link close}.
   */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  private closed = false;
  private closingPromise?: Promise<void>;

  /**
   * Creates an {@link Aclosing} wrapper around `asyncGenerator`.
   *
   * @param asyncGenerator The async generator to finalize when closed or
   *     disposed.
   */
  constructor(asyncGenerator: AsyncGenerator<T, TReturn, TNext>) {
    if (
      typeof asyncGenerator !== 'object' ||
      asyncGenerator === null ||
      typeof asyncGenerator.next !== 'function' ||
      typeof asyncGenerator.return !== 'function'
    ) {
      throw new TypeError(
        'Aclosing requires an AsyncGenerator with next() and return() methods.',
      );
    }

    this.asyncGenerator = asyncGenerator;

    const asyncDisposeSymbol =
      typeof Symbol.asyncDispose === 'symbol'
        ? Symbol.asyncDispose
        : Symbol.for('Symbol.asyncDispose');
    Object.defineProperty(this, asyncDisposeSymbol, {
      value: () => this.close(),
      configurable: true,
      enumerable: false,
    });
  }

  /**
   * Advances the wrapped async generator by one step.
   *
   * @param args Optional value sent into the generator.
   * @returns The next iterator result from the wrapped generator.
   */
  next(...args: [] | [TNext]): Promise<IteratorResult<T, TReturn>> {
    return this.asyncGenerator.next(...args);
  }

  /**
   * Closes the wrapped async generator idempotently by awaiting
   * `return(undefined)` at most once.
   */
  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closingPromise ??= this.performClose();
    return this.closingPromise;
  }

  /**
   * Iterates all values from the wrapped async generator and guarantees
   * {@link close} runs when iteration ends for any reason.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    try {
      while (true) {
        const result = await this.asyncGenerator.next();
        if (result.done) {
          return;
        }
        yield result.value;
      }
    } finally {
      await this.close();
    }
  }

  private async performClose(): Promise<void> {
    try {
      // TypeScript's AsyncGenerator<T, TReturn, TNext>.return() requires a
      // TReturn argument even though runtime %AsyncGeneratorPrototype%.return()
      // accepts undefined when closing an iterator early.
      await this.asyncGenerator.return(undefined as TReturn);
    } finally {
      this.closed = true;
      this.closingPromise = undefined;
    }
  }
}
