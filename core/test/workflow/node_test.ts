/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionNode, JoinNode, node, START} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {drainNode} from './workflow_test_utils.js';

describe('node()', () => {
  it('wraps a function in a FunctionNode named after it', () => {
    function classify() {
      return 'high';
    }

    const built = node(classify);

    expect(built).toBeInstanceOf(FunctionNode);
    expect(built.name).toBe('classify');
  });

  it('applies option overrides when wrapping a function', () => {
    const built = node(() => undefined, {name: 'named', timeoutMs: 7});

    expect(built.name).toBe('named');
    expect(built.timeoutMs).toBe(7);
  });

  it('returns an existing node unchanged when there is nothing to override', () => {
    const existing = new JoinNode({name: 'join'});

    expect(node(existing)).toBe(existing);
    expect(node(existing, {})).toBe(existing);
  });

  it('copies an existing node when options are given', () => {
    const existing = new JoinNode({name: 'join'});

    const copy = node(existing, {timeoutMs: 12});

    expect(copy).not.toBe(existing);
    expect(copy).toBeInstanceOf(JoinNode);
    expect(copy.name).toBe('join');
    expect(copy.timeoutMs).toBe(12);
    expect(existing.timeoutMs).toBeUndefined();
  });

  it("resolves the literal 'START' to the START sentinel", () => {
    expect(node('START')).toBe(START);
    expect(node('START', {name: 'ignored'})).toBe(START);
  });

  it('produces a node that runs the wrapped function', async () => {
    const built = node((_ctx, nodeInput) => `saw ${String(nodeInput)}`, {
      name: 'runner',
    });

    const {ctx} = await drainNode(built, 'input');

    expect(ctx.output).toBe('saw input');
  });
});
