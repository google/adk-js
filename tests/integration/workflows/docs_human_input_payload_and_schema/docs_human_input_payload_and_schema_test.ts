/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/human_input/payload_and_schema` — https://adk.dev/graphs/human-input/
 *
 * `message` + `payload` + `responseSchema` on one pause. It calls no model, so
 * it runs with the record/replay model on an empty response set: a stray model
 * call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: human_input/payload_and_schema', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_human_input_payload_and_schema',
      rootAgent,
      turns: ['Paris', 'the museum'],
      offline: true,
    });

    // Turn one pauses for the human; the reply arrives on the next turn.
    expect(
      perTurn[0].some((e) => (e.longRunningToolIds?.length ?? 0) > 0),
    ).toBe(true);

    expect(finalOutput(allEvents(perTurn))).toBe(
      'Noted. Building the final itinerary around: the museum',
    );
  });
});
