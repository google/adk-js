/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseNode,
  BaseNodeConfig,
  createEvent,
  Event,
  NodeContext,
  START,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {drainNode, makeNodeContext} from './workflow_test_utils.js';

interface EchoNodeConfig extends BaseNodeConfig {
  texts?: string[];
}

/** Emits one event per configured text and outputs its input. */
class EchoNode extends BaseNode<EchoNodeConfig> {
  override async *run(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    for (const text of this.config.texts ?? []) {
      yield createEvent({author: this.name, content: {parts: [{text}]}});
    }
    ctx.output = nodeInput;
  }
}

describe('BaseNode', () => {
  it('rejects a name that is not a valid identifier', () => {
    expect(() => new EchoNode({name: 'not a name'})).toThrow(
      "Node name 'not a name' must be a valid identifier.",
    );
  });

  it('accepts identifier-shaped names', () => {
    expect(new EchoNode({name: '_private$1'}).name).toBe('_private$1');
  });

  it('defaults waitForOutput and requiresAllPredecessors', () => {
    const n = new EchoNode({name: 'plain'});

    expect(n.waitForOutput).toBe(false);
    expect(n.requiresAllPredecessors).toBe(false);
    expect(n.retryConfig).toBeUndefined();
    expect(n.timeoutMs).toBeUndefined();
  });

  it('keeps the configured options', () => {
    const retryConfig = {maxAttempts: 2};
    const n = new EchoNode({
      name: 'configured',
      waitForOutput: true,
      retryConfig,
      timeoutMs: 25,
    });

    expect(n.waitForOutput).toBe(true);
    expect(n.retryConfig).toBe(retryConfig);
    expect(n.timeoutMs).toBe(25);
  });

  it('streams the events it yields and exposes the result on ctx', async () => {
    const n = new EchoNode({name: 'echo', texts: ['one', 'two']});

    const {events, ctx} = await drainNode(n, 'payload');

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual([
      'one',
      'two',
    ]);
    expect(events.every((e) => e.author === 'echo')).toBe(true);
    expect(ctx.output).toBe('payload');
  });

  it('clones into the same concrete class with overrides applied', () => {
    const original = new EchoNode({name: 'echo', texts: ['one']});

    const copy = original.clone({name: 'echo2', timeoutMs: 10});

    expect(copy).toBeInstanceOf(EchoNode);
    expect(copy).not.toBe(original);
    expect(copy.name).toBe('echo2');
    expect(copy.timeoutMs).toBe(10);
    expect(original.name).toBe('echo');
    expect(original.timeoutMs).toBeUndefined();
  });

  it('clones subclass-specific config with no overrides', async () => {
    const original = new EchoNode({name: 'echo', texts: ['kept']});

    const {events} = await drainNode(original.clone());

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual(['kept']);
  });
});

describe('START', () => {
  it('is named __START__', () => {
    expect(START.name).toBe('__START__');
  });

  it('throws if it is ever executed', () => {
    const ctx = makeNodeContext(START);

    expect(() => START.run(ctx, undefined)).toThrow(
      'START marks a graph entry point and is never executed.',
    );
  });
});
