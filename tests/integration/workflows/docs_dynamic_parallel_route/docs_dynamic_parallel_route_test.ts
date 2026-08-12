/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/parallel_route` — https://adk.dev/graphs/dynamic/
 *
 * A hand-rolled fan-out gathered with `Promise.all`. It calls no model, so it
 * runs with the record/replay model on an empty response set: a stray model
 * call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: dynamic/parallel_route', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_dynamic_parallel_route',
      rootAgent,
      turns: ['alpha, beta, gamma'],
      offline: true,
    });

    // Results come back in call order, not completion order.
    expect(finalOutput(allEvents(perTurn))).toBe(
      'alpha: 5 chars\nbeta: 4 chars\ngamma: 5 chars',
    );
  });
});
