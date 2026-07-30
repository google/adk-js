/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {JoinNode} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {drainNode} from './workflow_test_utils.js';

describe('JoinNode', () => {
  it('waits for all of its predecessors', () => {
    expect(new JoinNode({name: 'join'}).requiresAllPredecessors).toBe(true);
  });

  it('passes the aggregated predecessor outputs through as its output', async () => {
    const aggregated = {NodeA: 'a', NodeB: 'b'};

    const {events, ctx} = await drainNode(
      new JoinNode({name: 'join'}),
      aggregated,
    );

    expect(events).toEqual([]);
    expect(ctx.output).toBe(aggregated);
  });
});
