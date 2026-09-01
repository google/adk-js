/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agents that answer without a model, so the pipeline can be tested offline.
 */

import {
  BaseAgent,
  createEvent,
  type Event,
  type InvocationContext,
} from '@google/adk';

/** Replies with a fixed prefix plus whatever the user said. */
export class EchoAgent extends BaseAgent {
  constructor(
    name = 'echo',
    private readonly prefix = 'echo:',
  ) {
    super({name});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const said = context.userContent?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: `${this.prefix} ${said ?? ''}`.trim()}],
      },
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

/** Throws, to exercise the error path. */
export class FailingAgent extends BaseAgent {
  constructor(private readonly message = 'agent exploded') {
    super({name: 'failing'});
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    // Yields nothing and then fails, which is what a turn looks like when the
    // model call itself throws.
    yield* [];
    throw new Error(this.message);
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

/**
 * Takes a while, and gives up when interrupted — as a well-behaved agent
 * should, so that queueing behavior is deterministic rather than a race with a
 * timer.
 */
export class SlowAgent extends BaseAgent {
  /** Invocations that reached the agent body. */
  started = 0;
  /** Invocations that were not interrupted and produced a reply. */
  completed = 0;

  constructor(private readonly delayMs = 50) {
    super({name: 'slow'});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.started++;
    await delay(this.delayMs, context.abortSignal);
    if (context.abortSignal?.aborted) {
      return;
    }
    this.completed++;

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'done'}]},
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

/** Sleeps, returning early if the signal is aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, {once: true});
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}
