/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `loop` sample: a graph-level cycle that generates a headline,
 * grades it, and routes back to generation until it is graded tech-related.
 * Both turns mirror the Python goldens
 * `contributing/samples/workflows/loop/tests/{computer,flower}.json`: a
 * tech topic exits on the first pass, a non-tech one traverses the cycle.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

function grades(events: ReturnType<typeof allEvents>): string[] {
  return events
    .filter((e) => e.author === 'evaluate_headline' && e.output !== undefined)
    .map((e) => (e.output as {grade: string}).grade);
}

describe('workflow sample: loop', () => {
  it('exits after one pass when the topic is already tech-related', async () => {
    const perTurn = await runSample({
      name: 'loop',
      rootAgent,
      turns: ['computer'],
    });
    const events = allEvents(perTurn);

    expect(events.map((e) => e.actions?.stateDelta ?? {})).toContainEqual({
      topic: 'computer',
    });
    expect(authors(events).has('generate_headline')).toBe(true);
    expect(grades(events)).toEqual(['tech-related']);
    expect(events.filter((e) => e.author === 'generate_headline')).toHaveLength(
      1,
    );
    expect(events.map((e) => e.route).filter(Boolean)).toEqual([
      'tech-related',
    ]);
  }, 120000);

  it('routes back around the cycle when the headline is unrelated', async () => {
    const perTurn = await runSample({
      name: 'loop',
      rootAgent,
      turns: ['flower'],
    });
    const events = allEvents(perTurn);

    const passes = events.filter((e) => e.author === 'generate_headline');
    const allGrades = grades(events);

    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(allGrades.length).toBe(passes.length);
    expect(allGrades[allGrades.length - 1]).toBe('tech-related');
    expect(allGrades.slice(0, -1).every((g) => g === 'unrelated')).toBe(true);

    const routes = events.map((e) => e.route).filter(Boolean);
    expect(routes.filter((r) => r === 'unrelated')).toHaveLength(
      passes.length - 1,
    );

    const feedbackDelta = events
      .map((e) => e.actions?.stateDelta ?? {})
      .find((d) => 'feedback' in d);
    expect(feedbackDelta).toBeDefined();
  }, 120000);
});
