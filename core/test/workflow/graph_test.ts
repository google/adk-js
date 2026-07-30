/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_ROUTE,
  getLogger,
  Graph,
  JoinNode,
  LogLevel,
  setLogger,
  START,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

const a = new JoinNode({name: 'a'});
const b = new JoinNode({name: 'b'});
const c = new JoinNode({name: 'c'});
const d = new JoinNode({name: 'd'});

const realLogger = getLogger();

/** Installs a logger that records `warn` calls, and returns the recording. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  setLogger({
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args.join(' ')),
    error: () => {},
    setLogLevel: (_level: LogLevel) => {},
  });
  return warnings;
}

afterEach(() => {
  setLogger(realLogger);
});

describe('Graph', () => {
  it('derives its nodes from its edges, deduplicated and in first-seen order', () => {
    const graph = Graph.fromEdgeItems([
      [START, a, b],
      [a, c],
    ]);

    expect(graph.nodes.map((n) => n.name)).toEqual([
      '__START__',
      'a',
      'b',
      'c',
    ]);
  });

  it('reports the nodes with no outgoing edge as terminal', () => {
    const graph = Graph.fromEdgeItems([
      [START, a, b],
      [a, c],
    ]);

    expect([...graph.terminalNodeNames].sort()).toEqual(['b', 'c']);
  });

  it('accepts a valid graph', () => {
    const graph = Graph.fromEdgeItems([[START, a, b]]);

    expect(() => graph.validate()).not.toThrow();
  });

  it('accepts an empty graph', () => {
    const graph = Graph.fromEdgeItems([]);

    expect(() => graph.validate()).not.toThrow();
    expect(graph.nodes).toEqual([]);
    expect(graph.terminalNodeNames.size).toBe(0);
  });
});

describe('Graph.getNextPendingNodes', () => {
  it('always follows unrouted edges', () => {
    const graph = Graph.fromEdgeItems([[START, a, [b, c]]]);

    expect(graph.getNextPendingNodes('a').map((n) => n.name)).toEqual([
      'b',
      'c',
    ]);
  });

  it('follows only the edge matching the emitted route', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'left'},
      {fromNode: a, toNode: c, route: 'right'},
    ]);

    expect(graph.getNextPendingNodes('a', 'right').map((n) => n.name)).toEqual([
      'c',
    ]);
  });

  it('falls back to the DEFAULT_ROUTE edge when nothing matched', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'left'},
      {fromNode: a, toNode: c, route: DEFAULT_ROUTE},
    ]);

    expect(graph.getNextPendingNodes('a', 'nope').map((n) => n.name)).toEqual([
      'c',
    ]);
  });

  it('skips the DEFAULT_ROUTE edge when a specific route matched', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'left'},
      {fromNode: a, toNode: c, route: DEFAULT_ROUTE},
    ]);

    expect(graph.getNextPendingNodes('a', 'left').map((n) => n.name)).toEqual([
      'b',
    ]);
  });

  it('matches an edge declaring several routes', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: ['left', 'up']},
    ]);

    expect(graph.getNextPendingNodes('a', 'up').map((n) => n.name)).toEqual([
      'b',
    ]);
  });

  it('matches when the node emits several routes', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'left'},
      {fromNode: a, toNode: c, route: 'right'},
      {fromNode: a, toNode: d, route: 'down'},
    ]);

    expect(
      graph.getNextPendingNodes('a', ['left', 'down']).map((n) => n.name),
    ).toEqual(['b', 'd']);
  });

  it('follows unrouted edges alongside a matched routed edge', () => {
    const graph = Graph.fromEdgeItems([
      [START, a],
      [a, b],
      {fromNode: a, toNode: c, route: 'go'},
    ]);

    expect(graph.getNextPendingNodes('a', 'go').map((n) => n.name)).toEqual([
      'b',
      'c',
    ]);
  });

  it('warns and ends the branch when no routed edge matched', () => {
    const warnings = captureWarnings();
    const graph = Graph.fromEdgeItems([
      [START, a],
      {fromNode: a, toNode: b, route: 'left'},
    ]);

    expect(graph.getNextPendingNodes('a', 'right')).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'has conditional/DEFAULT edges but none were matched',
    );
  });

  it('does not warn when the node has no routed edges at all', () => {
    const warnings = captureWarnings();
    const graph = Graph.fromEdgeItems([[START, a, b]]);

    expect(graph.getNextPendingNodes('b')).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('Graph.validate', () => {
  it('rejects duplicate node names', () => {
    const duplicate = new JoinNode({name: 'a'});

    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        [START, duplicate],
      ]).validate(),
    ).toThrow('Graph validation failed. Duplicate node names found: a');
  });

  it('rejects a graph without START', () => {
    expect(() => Graph.fromEdgeItems([[a, b]]).validate()).toThrow(
      "Graph validation failed. START node (name: '__START__') not found",
    );
  });

  it('rejects a routed edge out of START', () => {
    expect(() =>
      Graph.fromEdgeItems([
        {fromNode: START, toNode: a, route: 'go'},
      ]).validate(),
    ).toThrow('Graph validation failed. Edges from START must not have routes');
  });

  it('rejects nodes unreachable from START', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        [b, c],
      ]).validate(),
    ).toThrow(
      'Graph validation failed. The following nodes are unreachable from ' +
        'START: b, c',
    );
  });

  it('rejects an incoming edge into START', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        [a, START],
      ]).validate(),
    ).toThrow('Graph validation failed. START node must not have incoming');
  });

  it('rejects a duplicated edge', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        [START, a],
      ]).validate(),
    ).toThrow('Graph validation failed. Duplicate edge found: from=__START__');
  });

  it('rejects DEFAULT_ROUTE combined with other routes in a list', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        {fromNode: a, toNode: b, route: ['left', DEFAULT_ROUTE]},
      ]).validate(),
    ).toThrow(
      'Graph validation failed. DEFAULT_ROUTE cannot be combined with other',
    );
  });

  it('rejects two DEFAULT_ROUTE edges out of the same node', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a],
        {fromNode: a, toNode: b, route: DEFAULT_ROUTE},
        {fromNode: a, toNode: c, route: DEFAULT_ROUTE},
      ]).validate(),
    ).toThrow(
      'Graph validation failed. Multiple DEFAULT_ROUTE edges found from node a',
    );
  });

  it('rejects a cycle made only of unrouted edges', () => {
    expect(() =>
      Graph.fromEdgeItems([
        [START, a, b],
        [b, a],
      ]).validate(),
    ).toThrow(
      'Graph validation failed. Unconditional cycle detected: a -> b -> a.',
    );
  });

  it('accepts a cycle that includes a routed edge', () => {
    const graph = Graph.fromEdgeItems([
      [START, a, b],
      {fromNode: b, toNode: a, route: 'again'},
      {fromNode: b, toNode: c, route: DEFAULT_ROUTE},
    ]);

    expect(() => graph.validate()).not.toThrow();
  });

  it('accepts a diamond, which revisits a node without cycling', () => {
    const graph = Graph.fromEdgeItems([[START, a, [b, c], d]]);

    expect(() => graph.validate()).not.toThrow();
  });
});
