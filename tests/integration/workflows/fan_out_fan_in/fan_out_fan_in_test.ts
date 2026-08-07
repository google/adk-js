/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `fan_out_fan_in` sample (offline): three functions run in
 * parallel on the same input, joined and aggregated.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: fan_out_fan_in', () => {
  it('runs three branches in parallel and joins their results', async () => {
    const perTurn = await runSample({
      name: 'fan_out_fan_in',
      rootAgent,
      turns: ['hello'],
      offline: true,
    });
    const events = allEvents(perTurn);

    // All three parallel branches ran.
    expect(authors(events).has('make_uppercase')).toBe(true);
    expect(authors(events).has('count_characters')).toBe(true);
    expect(authors(events).has('reverse_string')).toBe(true);

    // The aggregate node combined all three results.
    const text = events
      .filter((e) => e.author === 'aggregate')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(text).toContain('Uppercase: HELLO');
    expect(text).toContain('Character Count: 5');
    expect(text).toContain('Reversed: olleh');
  });
});
