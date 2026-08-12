/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/data_handling/structured_output` — https://adk.dev/graphs/data-handling/
 *
 * A typed object crosses an edge and is validated by schemas on both sides. It
 * calls no model, so it runs with the record/replay model on an empty response
 * set: a stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: data_handling/structured_output', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_data_handling_structured_output',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      'It is 10:10 AM in Paris right now.',
    );
  });
});
