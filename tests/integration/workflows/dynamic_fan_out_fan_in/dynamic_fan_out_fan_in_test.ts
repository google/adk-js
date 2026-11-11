/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `dynamic_fan_out_fan_in` sample: the orchestrator splits the
 * input, fans a worker agent out per topic via `ctx.runNode`, and renders the
 * results as a table. Python ships no golden for this sample; the turn is the
 * one its README suggests.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const TOPICS = ['AI', 'Cloud Computing', 'Quantum Computing'];

describe('workflow sample: dynamic_fan_out_fan_in', () => {
  it('fans out one worker per topic and aggregates into a table', async () => {
    const perTurn = await runSample({
      name: 'dynamic_fan_out_fan_in',
      rootAgent,
      turns: [TOPICS.join(', ')],
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('generator')).toBe(true);
    const headlines = events.filter(
      (e) => e.author === 'generator' && e.content?.parts?.length,
    );
    expect(headlines).toHaveLength(TOPICS.length);

    const texts = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '');
    expect(texts).toContain('Processing 3 topics in parallel.');

    const table = texts.find((t) => t.startsWith('### Aggregated Headlines'));
    expect(table).toBeDefined();
    for (const topic of TOPICS) {
      const row = table!
        .split('\n')
        .find((line) => line.startsWith(`| ${topic} |`));
      expect(row, `row for ${topic}`).toBeDefined();
      const headline = row!.split('|')[2].trim();
      expect(headline.length).toBeGreaterThan(0);
      expect(headline).not.toBe('undefined');
    }
  }, 120000);
});
