/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  FunctionNode,
  JoinNode,
  parseGraph,
  Trigger,
  validateGraph,
} from '../../src/workflow/index.js';

describe('Workflow Graph Parser & Validation', () => {
  const nodeA = new FunctionNode('node_a', () => 'A');
  const nodeB = new FunctionNode('node_b', () => 'B');
  const nodeC = new FunctionNode('node_c', () => 'C');
  const router = new FunctionNode('router', () => 'router_res');

  it('should parse sequential edges accurately', () => {
    const graph = parseGraph([['START', nodeA, nodeB, nodeC]]);
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.get('node_a')).toBe(nodeA);
    expect(graph.nodes.get('node_b')).toBe(nodeB);
    expect(graph.nodes.get('node_c')).toBe(nodeC);

    const startEdges = graph.adjacencyList.get('START') || [];
    expect(startEdges.length).toBe(1);
    expect(startEdges[0].target).toBe(nodeA);

    const aEdges = graph.adjacencyList.get('node_a') || [];
    expect(aEdges.length).toBe(1);
    expect(aEdges[0].target).toBe(nodeB);

    const bEdges = graph.adjacencyList.get('node_b') || [];
    expect(bEdges.length).toBe(1);
    expect(bEdges[0].target).toBe(nodeC);

    expect(graph.inboundCounts.get('node_a')).toBe(1);
    expect(graph.inboundCounts.get('node_b')).toBe(1);
    expect(graph.inboundCounts.get('node_c')).toBe(1);
  });

  it('should parse route maps and trigger tuples', () => {
    const customTrigger = Trigger.fromPredicate(() => true);
    const graph = parseGraph([
      ['START', router],
      [router, {ROUTE_X: nodeA, ROUTE_Y: nodeB}],
      [nodeA, [customTrigger, nodeC]],
    ]);

    expect(graph.nodes.size).toBe(4);
    const routerEdges = graph.adjacencyList.get('router') || [];
    expect(routerEdges.length).toBe(2);
    expect(routerEdges[0].target.name).toBe('node_a');
    expect(routerEdges[1].target.name).toBe('node_b');

    const aEdges = graph.adjacencyList.get('node_a') || [];
    expect(aEdges.length).toBe(1);
    expect(aEdges[0].trigger).toBe(customTrigger);
  });

  it('should throw during validation when a node is unreachable from START', () => {
    const graph = parseGraph([
      ['START', nodeA],
      [nodeB, nodeC], // nodeB and nodeC have no path from START
    ]);

    expect(() => validateGraph(graph)).toThrowError(
      /unreachable from "START"/i,
    );
  });

  it('should detect cycles and throw unless allowCycles is true', () => {
    const graph = parseGraph([
      ['START', nodeA, nodeB],
      [nodeB, nodeA], // cycle nodeB -> nodeA
    ]);

    expect(() => validateGraph(graph, {allowCycles: false})).toThrowError(
      /Cycle detected/i,
    );

    expect(() => validateGraph(graph, {allowCycles: true})).not.toThrow();
  });

  it('should validate JoinNode upstreamCount integrity', () => {
    const joinNode = new JoinNode('join_node', {upstreamCount: 2});
    const validGraph = parseGraph([
      ['START', nodeA, joinNode],
      ['START', nodeB, joinNode],
    ]);

    expect(() => validateGraph(validGraph)).not.toThrow();

    const invalidJoin = new JoinNode('bad_join', {upstreamCount: 5});
    const invalidGraph = parseGraph([['START', nodeA, invalidJoin]]);

    expect(() => validateGraph(invalidGraph)).toThrowError(
      /expects 5 upstream predecessors, but only has 1 inbound edges/i,
    );
  });
});
