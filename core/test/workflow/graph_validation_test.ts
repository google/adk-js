/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {START} from '../../src/workflow/base_node.js';
import {
  createGraphFromEdgeItems,
  DEFAULT_ROUTE,
  Edge,
  Graph,
} from '../../src/workflow/graph.js';
import {FnNode} from './test_helpers.js';

const n = (name: string) => new FnNode(name, (_c, i) => i);

/** Builds a graph from edge items (validation runs inside the factory). */
function build(edges: Parameters<typeof createGraphFromEdgeItems>[0]): Graph {
  return createGraphFromEdgeItems(edges);
}

describe('graph validation', () => {
  it('accepts a valid graph and computes terminal nodes', () => {
    const [a, b] = [n('a'), n('b')];
    const graph = build([['START', a, b]]);
    expect([...graph.terminalNodeNames]).toEqual(['b']);
  });

  it('rejects duplicate node names', () => {
    // Two distinct instances sharing a name.
    const a1 = new FnNode('dup', (_c, i) => i);
    const a2 = new FnNode('dup', (_c, i) => i);
    expect(() =>
      build([
        ['START', a1],
        [a1, a2],
      ]),
    ).toThrow(/duplicate node names/i);
  });

  it('rejects a missing START node', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() => build([[a, b]])).toThrow(/START node.*not found/i);
  });

  it('rejects a routed edge from START', () => {
    const a = n('a');
    expect(() => build([new Edge(START, a, 'go')])).toThrow(
      /edges from START must not have routes/i,
    );
  });

  it('rejects unreachable nodes', () => {
    const [a, orphan, b] = [n('a'), n('orphan'), n('b')];
    expect(() =>
      build([
        ['START', a],
        [orphan, b],
      ]),
    ).toThrow(/unreachable/i);
  });

  it('rejects duplicate edges', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() =>
      build([
        ['START', a],
        [a, b],
        [a, b],
      ]),
    ).toThrow(/duplicate edge/i);
  });

  it('allows two route keys pointing at the same node', () => {
    const [router, shared] = [n('router'), n('shared')];
    const graph = build([
      ['START', router],
      [router, {approve: shared, escalate: shared}],
    ]);
    expect(graph.getNextPendingNodes('router', 'approve')).toEqual(['shared']);
    expect(graph.getNextPendingNodes('router', 'escalate')).toEqual(['shared']);
  });

  it('allows a routed edge alongside an unconditional one to the same node', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() =>
      build([['START', a], [a, b], new Edge(a, b, 'retry')]),
    ).not.toThrow();
  });

  it('rejects the same route pointing at the same node twice', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() =>
      build([['START', a], new Edge(a, b, 'go'), new Edge(a, b, 'go')]),
    ).toThrow(/duplicate edge.*route="go"/i);
  });

  it('rejects a multi-route edge overlapping a single-route one', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() =>
      build([['START', a], new Edge(a, b, ['x', 'y']), new Edge(a, b, 'y')]),
    ).toThrow(/duplicate edge.*route="y"/i);
  });

  it('rejects multiple DEFAULT_ROUTE edges from one node', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    expect(() =>
      build([
        ['START', a],
        [a, {[DEFAULT_ROUTE]: b}],
        new Edge(a, c, DEFAULT_ROUTE),
      ]),
    ).toThrow(/DEFAULT_ROUTE/i);
  });

  it('rejects an unconditional cycle', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() =>
      build([
        ['START', a],
        [a, b],
        [b, a],
      ]),
    ).toThrow(/cycle/i);
  });

  it('allows a routed (conditional) cycle', () => {
    const [a, b] = [n('a'), n('b')];
    // a -> b unconditionally, b -> a only on route 'again' (conditional) => ok.
    const graph = build([
      ['START', a],
      [a, b],
      [b, {again: a, [DEFAULT_ROUTE]: n('done')}],
    ]);
    expect(graph).toBeInstanceOf(Graph);
  });
});
