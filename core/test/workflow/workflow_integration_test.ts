/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_ROUTE,
  JoinNode,
  node,
  NodeContext,
  START,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {runToCompletion} from './workflow_test_utils.js';

/**
 * Exercises the whole module end to end on one realistic graph: START fans out
 * to two nodes, a JoinNode gathers them, a routing node picks a branch through
 * DEFAULT_ROUTE, the chosen branch fails twice before succeeding under its
 * retry policy, and a terminal node produces the workflow's output.
 */
describe('workflow end to end', () => {
  it('runs a fan-out, join, route, retry and terminal-output graph', async () => {
    const executed: string[] = [];
    const track = (name: string) => executed.push(name);

    const fetchOrders = node(
      (ctx: NodeContext) => {
        track('fetchOrders');
        ctx.state.set('orderCount', 12);
        return 12;
      },
      {name: 'fetchOrders'},
    );

    const fetchReturns = node(
      async () => {
        track('fetchReturns');
        return 9;
      },
      {name: 'fetchReturns'},
    );

    const collect = new JoinNode({name: 'collect'});

    let joined: unknown;
    const classify = node(
      (ctx: NodeContext, nodeInput) => {
        track('classify');
        joined = nodeInput;
        const {fetchOrders: orders, fetchReturns: returns} = nodeInput as {
          fetchOrders: number;
          fetchReturns: number;
        };
        // Reads state written by an earlier node in the same run.
        expect(ctx.state.get<number>('orderCount')).toBe(orders);
        ctx.route = returns / orders > 0.9 ? 'alarming' : 'normal';
        return returns;
      },
      {name: 'classify'},
    );

    let escalateAttempts = 0;
    const escalate = node(
      (ctx: NodeContext, nodeInput) => {
        track(`escalate#${ctx.attemptCount}`);
        escalateAttempts++;
        if (escalateAttempts < 3) {
          throw new RangeError('pager unavailable');
        }
        return `escalated ${String(nodeInput)} returns`;
      },
      {
        name: 'escalate',
        retryConfig: {
          maxAttempts: 3,
          initialDelayMs: 0,
          jitter: 0,
          errors: [RangeError],
        },
      },
    );

    const alarm = node(
      () => {
        track('alarm');
        return 'alarm raised';
      },
      {name: 'alarm'},
    );

    const report = node(
      (_ctx, nodeInput) => {
        track('report');
        return `report: ${String(nodeInput)}`;
      },
      {name: 'report'},
    );

    const workflow = new Workflow({
      name: 'returnsTriage',
      maxSteps: 20,
      edges: [
        [START, [fetchOrders, fetchReturns]],
        [fetchOrders, collect],
        [fetchReturns, collect],
        [collect, classify],
        {fromNode: classify, toNode: alarm, route: 'alarming'},
        {fromNode: classify, toNode: escalate, route: DEFAULT_ROUTE},
        [escalate, report],
      ],
    });

    const {events, ctx} = await runToCompletion(workflow, 'nightly');

    expect(executed).toEqual([
      'fetchOrders',
      'fetchReturns',
      'classify',
      'escalate#1',
      'escalate#2',
      'escalate#3',
      'report',
    ]);
    // The join gathered both branches before classify ran.
    expect(joined).toEqual({fetchOrders: 12, fetchReturns: 9});
    expect(escalateAttempts).toBe(3);
    expect(ctx.output).toBe('report: escalated 9 returns');

    // Two failed attempts produced one error event each, and the state write
    // produced one event carrying the delta.
    expect(
      events.filter((e) => e.errorCode === 'RangeError').map((e) => e.author),
    ).toEqual(['escalate', 'escalate']);
    expect(
      events.filter((e) => Object.keys(e.actions.stateDelta).length > 0),
    ).toHaveLength(1);
  });
});
