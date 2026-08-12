/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/data_handling/session_state` — https://adk.dev/graphs/data-handling/
 *
 * A value written by one node is incremented by a second and read back by a
 * third. It calls no model, so it runs with the record/replay model on an
 * empty response set: a stray model call throws instead of reaching the
 * network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: data_handling/session_state', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_data_handling_session_state',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    // attempts: initialized, incremented once, then read back.
    expect(finalOutput(allEvents(perTurn))).toMatch(
      /^attempts state: 1 \(topic: hello world, /,
    );
  });
});
