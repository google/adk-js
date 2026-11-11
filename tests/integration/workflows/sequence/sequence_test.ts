/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `sequence` sample: the first agent names a random fruit and the
 * second describes a health benefit of it. Turn mirrors the Python golden
 * `contributing/samples/workflows/sequence/tests/go.json`.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: sequence', () => {
  it('feeds the first agent output into the second', async () => {
    const perTurn = await runSample({
      name: 'sequence',
      rootAgent,
      turns: ['go'],
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('generate_fruit_agent')).toBe(true);
    expect(authors(events).has('generate_benefit_agent')).toBe(true);

    const fruit = events
      .find((e) => e.author === 'generate_fruit_agent')
      ?.content?.parts?.map((p) => p.text ?? '')
      .join('')
      .trim();
    expect(fruit).toBeTruthy();
    expect(fruit!.split(/\s+/).length).toBeLessThanOrEqual(3);

    const benefit = finalOutput(events);
    expect(typeof benefit).toBe('string');
    const benefitText = String(benefit);
    expect(benefitText.length).toBeGreaterThan(0);
    expect(benefitText.toLowerCase()).toContain(
      fruit!.toLowerCase().replace(/[^a-z]/gi, ''),
    );
  });
});
