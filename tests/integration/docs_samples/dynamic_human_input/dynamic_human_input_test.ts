/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/human_input` — https://adk.dev/graphs/dynamic/
 *
 * A HITL leaf inside a `rerunOnResume: true` orchestrator. It calls no model,
 * so it runs with the record/replay model on an empty response set: a stray
 * model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../../samples/workflows/dynamic/human_input/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../../workflows/_harness/sample_harness.js';

describe('docs sample: dynamic/human_input', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'dynamic/human_input',
      rootAgent,
      turns: ['please approve', 'yes'],
      offline: true,
    });

    // Turn one pauses for the human; the reply arrives on the next turn.
    expect(
      perTurn[0].some((e) => (e.longRunningToolIds?.length ?? 0) > 0),
    ).toBe(true);

    // The orchestrator waited for the human instead of deciding on its own.
    expect(finalOutput(allEvents(perTurn))).toBe('Approved');
  });
});
