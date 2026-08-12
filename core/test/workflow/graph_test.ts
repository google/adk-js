/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
  });

  it('logs, without changing behaviour, when the route matches no edge', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b, c] = [n('a'), n('b'), n('c')];
    const graph = new Graph([new Edge(a, b, 'x'), new Edge(a, c, 'y')]);

    // Behaviour is unchanged and still matches adk-python: the branch stops.
    expect(graph.getNextPendingNodes('a', 'z')).toEqual([]);

    // ...but silence here is indistinguishable from a typo'd route key.
    expect(debug).toHaveBeenCalledOnce();
    const message = String(debug.mock.calls[0][0]);
    expect(message).toContain("Node 'a'");
    expect(message).toContain('"z"');
    expect(message).toContain('"x"');
    expect(message).toContain('"y"');
  });

  it('logs when no entry of an emitted route array matches', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, 'x')]);
    expect(graph.getNextPendingNodes('a', ['y', 'z'])).toEqual([]);
    expect(debug).toHaveBeenCalledOnce();
  });

  it('does not log when a DEFAULT_ROUTE edge catches the route', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b, d] = [n('a'), n('b'), n('d')];
    const graph = new Graph([
      new Edge(a, b, 'x'),
      new Edge(a, d, DEFAULT_ROUTE),
    ]);
    expect(graph.getNextPendingNodes('a', 'nope')).toEqual(['d']);
    expect(debug).not.toHaveBeenCalled();
  });

  it('does not log for a node with no conditional edges', () => {
    // A terminal node emitting a route is not a routing mistake: there are no
    // route-keyed edges for it to have missed.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b)]);
    expect(graph.getNextPendingNodes('b', 'anything')).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
  });

  it('does not log when no route was emitted at all', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, 'x')]);
    expect(graph.getNextPendingNodes('a', null)).toEqual([]);
    expect(graph.getNextPendingNodes('a', undefined)).toEqual([]);
    expect(graph.getNextPendingNodes('a', [])).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
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
    // The conditional-continue idiom: an edge for `true` and nothing for
    // `false`, where emitting `false` is meant to stop. Exempt from the
    // unmatched-route log for that reason.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    expect(graph.getNextPendingNodes('a', false)).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs a bare false when no true edge exists', () => {
    // The exemption is for the conditional-continue idiom specifically. With
    // the edges keyed to 'x', emitting `false` is a mistake like any other.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, 'x')]);
    expect(graph.getNextPendingNodes('a', false)).toEqual([]);
    expect(debug).toHaveBeenCalledOnce();
  });

  it('exempts the string "false" exactly as the boolean', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const [a, b] = [n('a'), n('b')];
    const graph = new Graph([new Edge(a, b, true)]);
    expect(graph.getNextPendingNodes('a', 'false')).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
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
