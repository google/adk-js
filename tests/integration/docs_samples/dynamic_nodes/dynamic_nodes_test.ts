/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/nodes` — https://adk.dev/graphs/dynamic/
 *
 * The `node()` factory and the `FunctionNode` constructor, run in sequence. It
 * calls no model, so it runs with the record/replay model on an empty response
 * set: a stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from '../../../../samples/workflows/dynamic/nodes/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../../workflows/_harness/sample_harness.js';

describe('docs sample: dynamic/nodes', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'dynamic/nodes',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      '>> Hello Hello hello world <<',
    );
  });
});
