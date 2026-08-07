/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  createGraphFromEdgeItems,
  DEFAULT_ROUTE,
  Edge,
  Graph,
  isEdge,
} from '../../src/workflow/graph.js';
import {FnNode} from './test_helpers.js';

const n = (name: string) => new FnNode(name, (_c, i) => i);

describe('isEdge', () => {
  it('recognizes an Edge instance', () => {
    expect(isEdge(new Edge(n('a'), n('b')))).toBe(true);
  });

  it('rejects non-edges', () => {
    expect(isEdge({})).toBe(false);
    expect(isEdge(null)).toBe(false);
    expect(isEdge(n('a'))).toBe(false);
    expect(isEdge('a->b')).toBe(false);
  });
});

describe('Graph.getNextPendingNodes', () => {
  it('fires all unconditional edges', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const graph = new Graph([new Edge(a, b), new Edge(a, c)]);
    expect(graph.getNextPendingNodes('a', undefined).sort()).toEqual([
      'b',
      'c',
    ]);
  });

  it('fires only the edge matching the emitted route', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const graph = new Graph([new Edge(a, b, 'x'), new Edge(a, c, 'y')]);
    expect(graph.getNextPendingNodes('a', 'x')).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', 'y')).toEqual(['c']);
    expect(graph.getNextPendingNodes('a', 'z')).toEqual([]);
  });

  it('matches numeric routes by string value (emitted number or string)', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    // Numeric route keys from a routing map arrive as numbers on the edge.
    const graph = new Graph([new Edge(a, b, 2), new Edge(a, c, 3)]);
    expect(graph.getNextPendingNodes('a', 2)).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', '2')).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', 3)).toEqual(['c']);
    expect(graph.getNextPendingNodes('a', '3')).toEqual(['c']);
  });

  it('matches boolean routes by string value', () => {
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, true)]);
    expect(graph.getNextPendingNodes('a', true)).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', 'true')).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', false)).toEqual([]);
  });

  it('matches an edge with a list of routes', () => {
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, ['x', 'y'])]);
    expect(graph.getNextPendingNodes('a', 'y')).toEqual(['b']);
  });

  it('matches when any of the emitted routes matches (fan-out)', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const graph = new Graph([new Edge(a, b, 'x'), new Edge(a, c, 'y')]);
    expect(graph.getNextPendingNodes('a', ['y', 'z']).sort()).toEqual(['c']);
  });

  it('takes the default route only when no specific route matches', () => {
    const [a, b, d] = [n('a'), n('b'), n('d')];
    const graph = new Graph([
      new Edge(a, b, 'x'),
      new Edge(a, d, DEFAULT_ROUTE),
    ]);
    expect(graph.getNextPendingNodes('a', 'x')).toEqual(['b']);
    expect(graph.getNextPendingNodes('a', 'unknown')).toEqual(['d']);
  });
});

describe('createGraphFromEdgeItems', () => {
  it('builds a graph and computes terminal nodes', () => {
    const [a, b] = [n('a'), n('b')];
    const graph = createGraphFromEdgeItems([['START', a, b]]);
    expect(graph.nodes.map((node) => node.name).sort()).toEqual([
      '__START__',
      'a',
      'b',
    ]);
    expect([...graph.terminalNodeNames]).toEqual(['b']);
  });

  it('validates at construction (throws on a graph without START)', () => {
    const [a, b] = [n('a'), n('b')];
    expect(() => createGraphFromEdgeItems([[a, b]])).toThrow();
  });
});
