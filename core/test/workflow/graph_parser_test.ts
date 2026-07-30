/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `parseEdgeItems` is internal, so this suite imports everything relatively:
// mixing it with `@google/adk` imports would pull in a second copy of the
// node classes and TypeScript would treat the two as unrelated.
import {describe, expect, it} from 'vitest';

import {START} from '../../src/workflow/base_node.js';
import {FunctionNode} from '../../src/workflow/function_node.js';
import {Edge} from '../../src/workflow/graph.js';
import {parseEdgeItems} from '../../src/workflow/graph_parser.js';
import {JoinNode} from '../../src/workflow/join_node.js';
import {DEFAULT_ROUTE} from '../../src/workflow/route.js';

const a = new JoinNode({name: 'a'});
const b = new JoinNode({name: 'b'});
const c = new JoinNode({name: 'c'});

function names(edges: Edge[]): string[][] {
  return edges.map((e) => [e.fromNode.name, e.toNode.name]);
}

describe('parseEdgeItems', () => {
  it('expands a chain into one edge per consecutive pair', () => {
    const edges = parseEdgeItems([[START, a, b]]);

    expect(names(edges)).toEqual([
      ['__START__', 'a'],
      ['a', 'b'],
    ]);
    expect(edges.every((e) => e.route === undefined)).toBe(true);
  });

  it('fans out to every node of an array step', () => {
    expect(names(parseEdgeItems([[START, [a, b]]]))).toEqual([
      ['__START__', 'a'],
      ['__START__', 'b'],
    ]);
  });

  it('fans in from every node of an array step', () => {
    expect(names(parseEdgeItems([[[a, b], c]]))).toEqual([
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it("resolves the literal 'START' to the START sentinel", () => {
    const edges = parseEdgeItems([['START', a]]);

    expect(edges[0].fromNode).toBe(START);
  });

  it('produces no edges for a chain with fewer than two steps', () => {
    expect(parseEdgeItems([[a]])).toEqual([]);
  });

  it('wraps a bare function once and reuses it by identity', () => {
    function step() {
      return 'done';
    }
    const edges = parseEdgeItems([
      [START, step],
      [step, a],
    ]);

    expect(edges[0].toNode).toBeInstanceOf(FunctionNode);
    expect(edges[0].toNode).toBe(edges[1].fromNode);
  });

  it('keeps distinct functions as distinct nodes', () => {
    const first = () => 'first';
    const second = () => 'second';

    const edges = parseEdgeItems([
      [START, first],
      [START, second],
    ]);

    expect(edges[0].toNode).not.toBe(edges[1].toNode);
  });

  it('mixes explicit edges and chains in one list, keeping routes', () => {
    const edges = parseEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'yes'},
      {fromNode: a, toNode: c, route: DEFAULT_ROUTE},
    ]);

    expect(names(edges)).toEqual([
      ['__START__', 'a'],
      ['a', 'b'],
      ['a', 'c'],
    ]);
    expect(edges[1].route).toBe('yes');
    expect(edges[2].route).toBe(DEFAULT_ROUTE);
  });

  it('copies an explicit edge so the caller cannot reshape the graph', () => {
    const spec = {fromNode: START, toNode: a};

    const edges = parseEdgeItems([spec]);
    spec.toNode = b;

    expect(edges[0].toNode).toBe(a);
  });
});
