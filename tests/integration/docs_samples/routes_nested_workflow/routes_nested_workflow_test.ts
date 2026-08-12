/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/routes/nested_workflow` — https://adk.dev/graphs/routes/
 *
 * A `Workflow` used as a node inside another workflow. It calls no model, so
 * it runs with the record/replay model on an empty response set: a stray model
 * call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../../samples/workflows/routes/nested_workflow/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../../workflows/_harness/sample_harness.js';

describe('docs sample: routes/nested_workflow', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'routes/nested_workflow',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe('[B] Hello World');
  });
});
