/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/routes/function_node` — https://adk.dev/graphs/routes/
 *
 * The primary node type: a bare return, then an explicit event. It calls no
 * model, so it runs with the record/replay model on an empty response set: a
 * stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: routes/function_node', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_routes_function_node',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe('HELLO WORLD IS AWESOME!');
  });
});
