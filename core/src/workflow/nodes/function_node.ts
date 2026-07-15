/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event, isEvent} from '../../events/event.js';
import {BaseNode, BaseNodeOptions} from '../base_node.js';

/**
 * Type for the function wrapped by a FunctionNode.
 * Can return a direct value, a Promise of a value, an Event, or an AsyncGenerator of Events.
 */
export type FunctionNodeHandler<TInput = unknown, TOutput = unknown> = (
  ctx: InvocationContext,
  input?: TInput,
) =>
  | AsyncGenerator<Event, TOutput, unknown>
  | Promise<TOutput | Event>
  | TOutput
  | Event;

/**
 * A concrete node that wraps a deterministic JavaScript/TypeScript function.
 * Automatically handles generator streams, Event returns, or boxes plain return values into Event outputs.
 */
export class FunctionNode<TInput = unknown, TOutput = unknown> extends BaseNode<
  TInput,
  TOutput
> {
  private readonly handler: FunctionNodeHandler<TInput, TOutput>;

  /**
   * @param name Unique name for this function node.
   * @param handler The execution logic function.
   * @param options Optional BaseNode configuration (rerunOnResume, retryConfig).
   */
  constructor(
    name: string,
    handler: FunctionNodeHandler<TInput, TOutput>,
    options?: BaseNodeOptions,
  ) {
    super(name, options);
    if (typeof handler !== 'function') {
      throw new Error(
        `FunctionNode "${name}" requires a valid function handler.`,
      );
    }
    this.handler = handler;
  }

  /**
   * Executes the wrapped handler function inside the workflow context.
   */
  async *run(
    ctx: InvocationContext,
    input?: TInput,
  ): AsyncGenerator<Event, TOutput, unknown> {
    const resultOrGen = this.handler(ctx, input);

    if (isAsyncGenerator(resultOrGen)) {
      const finalVal = yield* resultOrGen;
      this.lastOutputPayload = finalVal;
      return finalVal;
    }

    const res = await Promise.resolve(resultOrGen);

    if (isEvent(res)) {
      yield res;
      const extracted =
        res.content ??
        (typeof res.actions === 'object' &&
        res.actions !== null &&
        'output' in (res.actions as unknown as Record<string, unknown>)
          ? (res.actions as unknown as Record<string, unknown>).output
          : res);
      this.lastOutputPayload = extracted;
      return extracted as TOutput;
    }

    if (res !== undefined && res !== null) {
      const boxedEvent = createEvent({
        invocationId: ctx.invocationId,
        author: this.name,
        branch: ctx.branch,
        content: toContent(res),
        actions: {output: res},
      });
      yield boxedEvent;
    }

    this.lastOutputPayload = res;
    return res as TOutput;
  }
}

function isAsyncGenerator(
  obj: unknown,
): obj is AsyncGenerator<Event, unknown, unknown> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    Symbol.asyncIterator in obj &&
    'next' in obj &&
    typeof (obj as Record<string, unknown>).next === 'function'
  );
}

function toContent(val: unknown): Content | undefined {
  if (!val) return undefined;
  if (typeof val === 'object' && 'role' in val && 'parts' in val) {
    return val as Content;
  }
  if (typeof val === 'string') {
    return {
      role: 'model',
      parts: [{text: val}],
    };
  }
  try {
    return {
      role: 'model',
      parts: [{text: JSON.stringify(val)}],
    };
  } catch {
    return {
      role: 'model',
      parts: [{text: String(val)}],
    };
  }
}
