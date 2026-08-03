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
} from '../../src/workflow/graph.js';
import {parseEdgeItems} from '../../src/workflow/utils/graph_parser.js';
import {FnNode} from './test_helpers.js';

const n = (name: string) => new FnNode(name, (_c, i) => i);

/** Serializes edges to `from->to[:route]` strings for compact assertions. */
function edgeStrings(edges: Edge[]): string[] {
  return edges.map((e) => {
    const route =
      e.route === null || e.route === undefined
        ? ''
        : `:${JSON.stringify(e.route)}`;
    return `${e.fromNode.name}->${e.toNode.name}${route}`;
  });
}

describe('graph parser', () => {
  it('parses a linear chain', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([['START', a, b, c]]);
    expect(edgeStrings(edges)).toEqual(['__START__->a', 'a->b', 'b->c']);
  });

  it('parses a fan-out array to multiple edges', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([['START', [a, b], c]]);
    expect(edgeStrings(edges)).toEqual([
      '__START__->a',
      '__START__->b',
      'a->c',
      'b->c',
    ]);
  });

  it('parses a routing map into conditional edges', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([[a, {question: b, statement: c}]]);
    expect(edgeStrings(edges)).toEqual(['a->b:"question"', 'a->c:"statement"']);
  });

  it('parses numeric route keys', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([[a, {1: b, 2: c}]]);
    expect(edgeStrings(edges)).toEqual(['a->b:1', 'a->c:2']);
  });

  it('parses fan-out inside a routing map', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([[a, {retry: [b, c]}]]);
    expect(edgeStrings(edges)).toEqual(['a->b:"retry"', 'a->c:"retry"']);
  });

  it('parses DEFAULT_ROUTE keys', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const edges = parseEdgeItems([[a, {ok: b, [DEFAULT_ROUTE]: c}]]);
    expect(edgeStrings(edges)).toEqual([
      'a->b:"ok"',
      `a->c:${JSON.stringify(DEFAULT_ROUTE)}`,
    ]);
  });

  it('passes explicit Edge instances through', () => {
    const [a, b] = [n('a'), n('b')];
    const edges = parseEdgeItems([new Edge(a, b, 'go')]);
    expect(edgeStrings(edges)).toEqual(['a->b:"go"']);
  });

  it('rejects consecutive routing maps in a chain', () => {
    const [a] = [n('a')];
    expect(() => parseEdgeItems([[a, {x: n('b')}, {y: n('c')}]])).toThrow(
      /consecutive routing maps/i,
    );
  });

  it('rejects an empty routing map', () => {
    const a = n('a');
    expect(() => parseEdgeItems([[a, {}]])).toThrow(/empty/i);
  });

  it('dedupes nodes by identity in the Graph', () => {
    const [a, b, c] = [n('a'), n('b'), n('c')];
    // `a` referenced in two edge items -> one node in the graph.
    const graph = createGraphFromEdgeItems([
      ['START', a, b],
      [a, c],
    ]);
    expect(graph.nodes.map((node) => node.name).sort()).toEqual([
      '__START__',
      'a',
      'b',
      'c',
    ]);
    // Exactly one `a` instance.
    expect(graph.nodes.filter((node) => node.name === 'a')).toHaveLength(1);
  });
});
