/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NodeContext, node} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {makeInvocationContext} from './workflow_test_utils.js';

const noop = node(() => undefined, {name: 'noop'});

describe('NodeContext', () => {
  it('builds a root node path from the node name and run id', () => {
    const ctx = new NodeContext({
      invocationContext: makeInvocationContext(),
      node: noop,
      runId: '3',
    });

    expect(ctx.nodePath).toBe('noop@3');
    expect(ctx.attemptCount).toBe(1);
    expect(ctx.node).toBe(noop);
    expect(ctx.runId).toBe('3');
  });

  it('nests the node path under the parent node path', () => {
    const ctx = new NodeContext({
      invocationContext: makeInvocationContext(),
      node: noop,
      runId: '1',
      parentNodePath: 'outer@2',
      attemptCount: 4,
    });

    expect(ctx.nodePath).toBe('outer@2/noop@1');
    expect(ctx.attemptCount).toBe(4);
  });

  it('exposes delta-aware session state', () => {
    const invocationContext = makeInvocationContext();
    invocationContext.session.state['seed'] = 1;
    const ctx = new NodeContext({invocationContext, node: noop, runId: '1'});

    ctx.state.set('added', 2);

    expect(ctx.state.get('seed')).toBe(1);
    expect(ctx.actions.stateDelta).toEqual({added: 2});
  });

  it('starts with no output and no route', () => {
    const ctx = new NodeContext({
      invocationContext: makeInvocationContext(),
      node: noop,
      runId: '1',
    });

    expect(ctx.output).toBeUndefined();
    expect(ctx.route).toBeUndefined();
  });
});
