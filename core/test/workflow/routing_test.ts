/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {createEvent} from '../../src/events/event.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {DEFAULT_ROUTE, Edge, RouteValue} from '../../src/workflow/graph.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveNode, FnNode} from './test_helpers.js';

const emit = (name: string, route: RouteValue): BaseNode =>
  new FnNode(name, () => createEvent({route, output: route}));

const echo = (name: string): BaseNode =>
  new FnNode(name, (_c, i) => `${name}(${i})`);

describe('workflow routing values', () => {
  it('matches numeric route keys', async () => {
    const router = emit('router', 2);
    const a = echo('a');
    const b = echo('b');
    const wf = new Workflow({
      name: 'numeric_route',
      edges: [
        ['START', router],
        [router, {1: a, 2: b}],
      ],
    });
    expect((await driveNode(wf, 'x')).output).toBe('b(2)');
  });

  it('matches a list route on an explicit Edge (any listed value)', async () => {
    const router = emit('router', 3);
    const target = echo('target');
    const other = echo('other');
    const wf = new Workflow({
      name: 'list_route',
      edges: [
        ['START', router],
        new Edge(router, target, [2, 3]),
        new Edge(router, other, 9),
      ],
    });
    expect((await driveNode(wf, 'x')).output).toBe('target(3)');
  });

  it('reuses one sub-workflow instance across two route keys', async () => {
    const shared = new Workflow({
      name: 'shared_sub',
      edges: [['START', echo('wrapped')]],
    });
    const build = (route: RouteValue) => {
      const router = emit('router', route);
      return new Workflow({
        name: 'reuse_parent',
        edges: [
          ['START', router],
          [router, {approve: shared, escalate: shared}],
        ],
      });
    };
    expect((await driveNode(build('approve'), 'x')).output).toBe(
      'wrapped(approve)',
    );
    expect((await driveNode(build('escalate'), 'x')).output).toBe(
      'wrapped(escalate)',
    );
  });

  it('fans out from a single route to multiple nodes, then joins', async () => {
    const router = emit('router', 'go');
    const a = echo('a');
    const b = echo('b');
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'route_fan_out',
      edges: [
        ['START', router],
        [router, {go: [a, b]}],
        [[a, b], join],
      ],
    });
    expect((await driveNode(wf, 'x')).output).toEqual({
      a: 'a(go)',
      b: 'b(go)',
    });
  });

  it('uses DEFAULT_ROUTE only when no specific route matches', async () => {
    // Specific route matches -> takes the specific branch.
    const router = emit('router', 'known');
    const wfMatch = new Workflow({
      name: 'default_route_match',
      edges: [
        ['START', router],
        [router, {known: echo('a'), [DEFAULT_ROUTE]: echo('fb')}],
      ],
    });
    expect((await driveNode(wfMatch, 'x')).output).toBe('a(known)');

    // No specific route matches -> falls back to DEFAULT_ROUTE.
    const router2 = emit('router2', 'unknown');
    const wfFallback = new Workflow({
      name: 'default_route_fallback',
      edges: [
        ['START', router2],
        [router2, {known: echo('a2'), [DEFAULT_ROUTE]: echo('fb2')}],
      ],
    });
    expect((await driveNode(wfFallback, 'x')).output).toBe('fb2(unknown)');
  });

  it('matches a boolean route key in a routing map', async () => {
    const router = emit('router', true);
    const wf = new Workflow({
      name: 'bool_route',
      edges: [
        ['START', router],
        [router, {true: echo('yes'), false: echo('no')}],
      ],
    });
    expect((await driveNode(wf, 'x')).output).toBe('yes(true)');
  });

  it('fires multiple branches when a node emits an array of routes', async () => {
    const router = new FnNode('router', () =>
      createEvent({route: ['a', 'b'], output: 'msg'}),
    );
    const a = echo('a');
    const b = echo('b');
    const c = echo('c'); // present in the map but not emitted -> must not run
    const join = new JoinNode({name: 'join'});
    const wf = new Workflow({
      name: 'multi_route',
      edges: [
        ['START', router],
        [router, {a, b, c}],
        [[a, b], join],
      ],
    });
    expect((await driveNode(wf, 'x')).output).toEqual({
      a: 'a(msg)',
      b: 'b(msg)',
    });
  });
});
