/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/routes/loop_escalation` — https://adk.dev/graphs/routes/
 *
 * A back-edge cycle that exits through a routed branch. It calls no model, so
 * it runs with the record/replay model on an empty response set: a stray model
 * call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../../samples/workflows/routes/loop_escalation/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../../workflows/_harness/sample_harness.js';

describe('docs sample: routes/loop_escalation', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'routes/loop_escalation',
      rootAgent,
      turns: ['graph workflows'],
      offline: true,
    });

    // Two refine passes, then the router picks the terminal branch.
    expect(finalOutput(allEvents(perTurn))).toMatch(
      /^Approved after 3 bullets:/,
    );
  });
});
