/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/data_handling/user_message` — https://adk.dev/graphs/data-handling/
 *
 * A display message is not what the next node receives; `output` is. It calls
 * no model, so it runs with the record/replay model on an empty response set:
 * a stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: data_handling/user_message', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_data_handling_user_message',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    // The report node got the sources array, not the "Gathering sources..." text.
    expect(finalOutput(allEvents(perTurn))).toBe(
      'Research complete. 3 sources: source-a, source-b, source-c.',
    );
  });
});
