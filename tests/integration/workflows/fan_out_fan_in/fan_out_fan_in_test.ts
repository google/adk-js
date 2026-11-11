/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `fan_out_fan_in` sample (offline): three functions run in
 * parallel on the same input, joined and aggregated. Turn and expectations
 * mirror the Python golden
 * `contributing/samples/workflows/fan_out_fan_in/tests/go.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: fan_out_fan_in', () => {
  it('runs three branches in parallel and joins their results', async () => {
    const perTurn = await runSample({
      name: 'fan_out_fan_in',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('make_uppercase')).toBe(true);
    expect(authors(events).has('count_characters')).toBe(true);
    expect(authors(events).has('reverse_string')).toBe(true);

    const outputOf = (author: string) =>
      events.find((e) => e.author === author && e.output !== undefined)?.output;
    expect(outputOf('make_uppercase')).toBe('GO');
    expect(outputOf('count_characters')).toBe(2);
    expect(outputOf('reverse_string')).toBe('og');

    expect(outputOf('join_for_results')).toEqual({
      make_uppercase: 'GO',
      count_characters: 2,
      reverse_string: 'og',
    });

    const text = events
      .filter((e) => e.author === 'aggregate')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(text).toBe(
      'Uppercase: GO\n\nCharacter Count: 2\n\nReversed: og\n\n',
    );
  });
});
