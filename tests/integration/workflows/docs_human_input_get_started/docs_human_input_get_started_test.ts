/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/human_input/get_started` — https://adk.dev/graphs/human-input/
 *
 * The two-node pause: `RequestInput`, then the reply feeds the next node. It
 * calls no model, so it runs with the record/replay model on an empty response
 * set: a stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: human_input/get_started', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_human_input_get_started',
      rootAgent,
      turns: ['start', '21'],
      offline: true,
    });

    // Turn one pauses for the human; the reply arrives on the next turn.
    expect(
      perTurn[0].some((e) => (e.longRunningToolIds?.length ?? 0) > 0),
    ).toBe(true);

    // step1 does not re-run on resume; it completes with the reply as its output.
    expect(finalOutput(allEvents(perTurn))).toBe(42);
  });
});
