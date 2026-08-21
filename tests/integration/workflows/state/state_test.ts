/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `state` sample (offline): read/write shared workflow state.
 * Turn and expectations mirror the Python golden
 * `contributing/samples/workflows/state/tests/go.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: state', () => {
  it('threads values through state across nodes', async () => {
    const perTurn = await runSample({
      name: 'state',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);

    const deltas = events
      .map((e) => e.actions?.stateDelta ?? {})
      .filter((d) => Object.keys(d).length > 0);
    expect(deltas).toEqual([
      {original_text: 'go'},
      {uppercased_text: 'GO'},
      {appended_text: 'GO (Original was: go)'},
    ]);

    expect(finalOutput(events)).toBe('Final Result: GO (Original was: go)!');
  });
});
