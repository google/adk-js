/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/routes/fan_out_join` — https://adk.dev/graphs/routes/
 *
 * Parallel paths merged by a `JoinNode` barrier. It calls no model, so it runs
 * with the record/replay model on an empty response set: a stray model call
 * throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: routes/fan_out_join', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_routes_fan_out_join',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    // The join hands its successor a record keyed by predecessor node name.
    expect(finalOutput(allEvents(perTurn))).toBe(
      'Uppercase: HELLO WORLD\nLength:    11\nReversed:  dlrow olleh',
    );
  });
});
