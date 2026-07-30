/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event, FunctionNode, NodeContext} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {drainNode} from './workflow_test_utils.js';

describe('FunctionNode', () => {
  it('infers its name from the wrapped function', () => {
    function analyse() {
      return 'ok';
    }

    expect(new FunctionNode({fn: analyse}).name).toBe('analyse');
  });

  it('prefers an explicit name over the function name', () => {
    function analyse() {
      return 'ok';
    }

    expect(new FunctionNode({fn: analyse, name: 'custom'}).name).toBe('custom');
  });

  it('rejects an anonymous function with no name', () => {
    const anonymous: (ctx: NodeContext, nodeInput: unknown) => unknown =
      function () {
        return 'ok';
      };
    Object.defineProperty(anonymous, 'name', {value: ''});

    expect(() => new FunctionNode({fn: anonymous})).toThrow(
      'FunctionNode must have a name.',
    );
  });

  it('turns a synchronous return value into the node output', async () => {
    const n = new FunctionNode({fn: () => 42, name: 'sync'});

    const {events, ctx} = await drainNode(n);

    expect(events).toEqual([]);
    expect(ctx.output).toBe(42);
  });

  it('turns an awaited return value into the node output', async () => {
    const n = new FunctionNode({fn: async () => 'later', name: 'async'});

    const {ctx} = await drainNode(n);

    expect(ctx.output).toBe('later');
  });

  it('treats undefined as no output', async () => {
    const n = new FunctionNode({fn: () => undefined, name: 'nothing'});

    const {ctx} = await drainNode(n);

    expect(ctx.output).toBeUndefined();
  });

  it('treats null as no output', async () => {
    const n = new FunctionNode({fn: () => null, name: 'nullish'});

    const {ctx} = await drainNode(n);

    expect(ctx.output).toBeUndefined();
  });

  it('streams the events an async generator function yields', async () => {
    async function* streamer(
      ctx: NodeContext,
    ): AsyncGenerator<Event, void, void> {
      yield createEvent({author: 'streamer', content: {parts: [{text: 'a'}]}});
      yield createEvent({author: 'streamer', content: {parts: [{text: 'b'}]}});
      ctx.output = 'streamed';
    }
    const n = new FunctionNode({fn: streamer});

    const {events, ctx} = await drainNode(n);

    expect(events.map((e) => e.content?.parts?.[0].text)).toEqual(['a', 'b']);
    expect(ctx.output).toBe('streamed');
  });

  it('passes the node input to the wrapped function', async () => {
    const seen: unknown[] = [];
    const n = new FunctionNode({
      fn: (_ctx, nodeInput) => {
        seen.push(nodeInput);
        return undefined;
      },
      name: 'recorder',
    });

    await drainNode(n, {from: 'upstream'});

    expect(seen).toEqual([{from: 'upstream'}]);
  });

  it('lets the wrapped function emit a route', async () => {
    const n = new FunctionNode({
      fn: (ctx) => {
        ctx.route = 'high';
      },
      name: 'router',
    });

    const {ctx} = await drainNode(n);

    expect(ctx.route).toBe('high');
  });

  it('records state writes on the context delta', async () => {
    const n = new FunctionNode({
      fn: (ctx) => {
        ctx.state.set('visited', true);
      },
      name: 'writer',
    });

    const {ctx} = await drainNode(n);

    expect(ctx.actions.stateDelta).toEqual({visited: true});
  });

  it('carries the wrapped function through clone', async () => {
    const original = new FunctionNode({fn: () => 'value', name: 'origin'});

    const copy = original.clone({name: 'copy', timeoutMs: 5});
    const {ctx} = await drainNode(copy);

    expect(copy).toBeInstanceOf(FunctionNode);
    expect(copy.name).toBe('copy');
    expect(copy.timeoutMs).toBe(5);
    expect(ctx.output).toBe('value');
  });
});
