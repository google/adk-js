/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `parallel_worker` sample: a topic list is fanned out across a
 * per-item function worker and a per-item agent worker, then aggregated. Turn
 * and expectations mirror the Python golden
 * `contributing/samples/workflows/parallel_worker/tests/flower.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: parallel_worker', () => {
  it('maps both workers across the generated topics and aggregates', async () => {
    const perTurn = await runSample({
      name: 'parallel_worker',
      rootAgent,
      turns: ['flower'],
    });
    const events = allEvents(perTurn);

    expect(events.map((e) => e.actions?.stateDelta ?? {})).toContainEqual({
      topic: 'flower',
    });
    expect(authors(events).has('find_related_topics')).toBe(true);

    const topics = events.find(
      (e) => e.author === 'find_related_topics' && e.output !== undefined,
    )?.output as string[];
    expect(topics.length).toBeGreaterThanOrEqual(3);

    const uppercased = events
      .filter((e) => e.author === 'make_upper_case' && e.output !== undefined)
      .map((e) => e.output)
      .filter((o) => typeof o === 'string') as string[];
    expect(uppercased.sort()).toEqual(
      topics.map((t) => t.toUpperCase()).sort(),
    );

    const explanations = events
      .filter((e) => e.author === 'explain_topic' && e.output !== undefined)
      .map((e) => e.output)
      .filter(
        (o): o is {topic: string; explanation: string} =>
          !Array.isArray(o) && typeof o === 'object' && o !== null,
      );
    expect(explanations).toHaveLength(topics.length);

    const text = events
      .filter((e) => e.author === 'aggregate')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(text.split('\n\n---\n\n')).toHaveLength(topics.length);
    for (const item of explanations) {
      expect(text).toContain(`${item.topic}: ${item.explanation}`);
    }
  }, 120000);
});
