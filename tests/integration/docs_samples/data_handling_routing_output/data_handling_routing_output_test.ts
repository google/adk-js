/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/data_handling/routing_output` — https://adk.dev/graphs/data-handling/
 *
 * One event carries both a route and the payload the branch receives. It calls
 * no model, so it runs with the record/replay model on an empty response set:
 * a stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../../samples/workflows/data_handling/routing_output/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../../workflows/_harness/sample_harness.js';

describe('docs sample: data_handling/routing_output', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'data_handling/routing_output',
      rootAgent,
      turns: ['this is a bug report'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      'Filed a bug for: this is a bug report',
    );
  });
});
