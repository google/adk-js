/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthConfig} from '../../auth/auth_tool.js';
import {createEvent, Event, isEvent} from '../../events/event.js';
import {BaseNode, BaseNodeConfig, isContent, toContent} from '../base_node.js';
import {NodeContext} from '../node_context.js';
import {
  createAuthRequestEvent,
  hasAuthCredential,
  processAuthResume,
} from '../utils/hitl_utils.js';

/**
 * A value a {@link FunctionNodeHandler} may return or yield.
 */
export type FunctionNodeResult<TOutput> =
  | TOutput
  | Event
  | null
  | undefined
  | void;

/**
 * The handler wrapped by a {@link FunctionNode}.
 *
 * Unlike Python's `FunctionNode` (which binds named parameters from `ctx.state`
 * or `node_input` via runtime signature introspection), the TypeScript form
 * uses the idiomatic explicit `(ctx, input)` signature. Read `ctx.state`
 * directly for state-bound values. It may return a value/`Event`, a Promise, or
 * a (sync/async) generator of those.
 */
export type FunctionNodeHandler<TInput = unknown, TOutput = unknown> = (
  ctx: NodeContext,
  input: TInput,
) =>
  | FunctionNodeResult<TOutput>
  | Promise<FunctionNodeResult<TOutput>>
  | Generator<FunctionNodeResult<TOutput>, void, unknown>
  | AsyncGenerator<FunctionNodeResult<TOutput>, void, unknown>;

/**
 * Options for a {@link FunctionNode}.
 */
export interface FunctionNodeConfig extends Partial<
  Omit<BaseNodeConfig, 'name'>
> {
  /**
   * If set, the framework requests user authentication before running (Phase 5
   * enables the auth gate; stored here now for API parity).
   */
  authConfig?: AuthConfig;
}

/**
 * A node that wraps a plain function, async function, or (sync/async) generator.
 *
 * Ported (TS-idiomatic subset) from `google/adk-python` `_function_node.py`.
 * Return-value handling:
 *  - `Event` → emitted as-is (output validated against `outputSchema`)
 *  - genai `Content` → emitted as the event content
 *  - `null`/`undefined` → skipped (unless there are pending state deltas)
 *  - anything else → emitted as `Event(output=value)`
 * State written via `ctx.state` during execution is attached to emitted events.
 */
export class FunctionNode<TInput = unknown, TOutput = unknown> extends BaseNode<
  TInput,
  TOutput
> {
  readonly authConfig?: AuthConfig;
  private readonly handler: FunctionNodeHandler<TInput, TOutput>;

  constructor(
    name: string,
    handler: FunctionNodeHandler<TInput, TOutput>,
    config: FunctionNodeConfig = {},
  ) {
    if (typeof handler !== 'function') {
      throw new TypeError('FunctionNode handler must be a function.');
    }
    super({name, ...config});
    this.handler = handler;
    this.authConfig = config.authConfig;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void> {
    // Auth gate: request credentials (and interrupt) if not yet available.
    if (this.authConfig) {
      const authRequest = await this.runAuthGate(ctx);
      if (authRequest) {
        yield authRequest;
        return;
      }
    }

    const result = this.handler(ctx, input);

    if (isAsyncIterable(result)) {
      for await (const item of result) {
        yield item;
      }
    } else if (isSyncGenerator(result)) {
      for (const item of result) {
        yield item;
      }
    } else {
      // Plain value or Promise of a value.
      yield await (result as Promise<FunctionNodeResult<TOutput>>);
    }
  }

  /**
   * Ensures a credential for `authConfig` is available. Returns an
   * `adk_request_credential` interrupt event if the credential must be
   * requested from the user, or `undefined` if the node may proceed.
   *
   * On resume, a credential provided via `ctx.resumeInputs[credentialKey]` is
   * stored into state before re-checking.
   */
  private async runAuthGate(ctx: NodeContext): Promise<Event | undefined> {
    const authConfig = this.authConfig!;
    if (hasAuthCredential(authConfig, ctx.state)) {
      return undefined;
    }
    const resumeResponse = ctx.resumeInputs[authConfig.credentialKey];
    if (resumeResponse !== undefined) {
      await processAuthResume(resumeResponse, authConfig, ctx.state);
      if (hasAuthCredential(authConfig, ctx.state)) {
        return undefined;
      }
    }
    // The credential key doubles as a deterministic interrupt id so the resume
    // response matches across turns.
    return createAuthRequestEvent(authConfig, authConfig.credentialKey);
  }

  protected override toEvent(ctx: NodeContext, data: unknown): Event | null {
    const stateDelta =
      Object.keys(ctx.actions.stateDelta).length > 0
        ? {...ctx.actions.stateDelta}
        : undefined;

    if (data === null || data === undefined) {
      return stateDelta
        ? createEvent({
            author: this.name,
            invocationId: ctx.invocationId,
            branch: ctx.branch,
            actions: {stateDelta},
          })
        : null;
    }

    if (isEvent(data)) {
      const event = data as Event;
      if (event.output !== undefined) {
        event.output = this.validateOutput(event.output);
      }
      if (stateDelta) {
        Object.assign(event.actions.stateDelta, stateDelta);
      }
      return event;
    }

    if (isContent(data)) {
      return createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        content: data,
        actions: stateDelta ? {stateDelta} : undefined,
      });
    }

    const output = this.validateOutput(data);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      content: toContent(output),
      output,
      actions: stateDelta ? {stateDelta} : undefined,
    });
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

function isSyncGenerator(value: unknown): value is Generator<unknown> {
  return (
    value != null &&
    typeof value !== 'string' &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function' &&
    typeof (value as Generator<unknown>).next === 'function'
  );
}
