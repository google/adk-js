/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/custom_run_ids` — https://adk.dev/graphs/dynamic/
 *
 * A reorderable collection, keyed by each item's own run id. It calls no
 * model, so it runs with the record/replay model on an empty response set: a
 * stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: dynamic/custom_run_ids', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_dynamic_custom_run_ids',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      'order a91: 2 item(s) shipped\n' +
        'order b02: 1 item(s) shipped\n' +
        'order c73: 3 item(s) shipped',
    );
  });
});
