/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `dynamic_nodes` sample: one `orchestrate` node drives two agents
 * with `ctx.runNode` until the headline grades tech-related. Turn mirrors the
 * Python golden `contributing/samples/workflows/dynamic_nodes/tests/flower.json`,
 * which deliberately uses a non-tech topic so the loop iterates.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: dynamic_nodes', () => {
  it('loops until the generated headline is graded tech-related', async () => {
    const perTurn = await runSample({
      name: 'dynamic_nodes',
      rootAgent,
      turns: ['flower'],
    });
    const events = allEvents(perTurn);

    expect(events.map((e) => e.actions?.stateDelta ?? {})).toContainEqual({
      topic: 'flower',
    });

    const who = authors(events);
    expect(who.has('generate_headline')).toBe(true);
    expect(who.has('evaluate_headline')).toBe(true);

    const headlines = events.filter((e) => e.author === 'generate_headline');
    expect(headlines.length).toBeGreaterThanOrEqual(2);
    const grades = events
      .filter((e) => e.author === 'evaluate_headline' && e.output !== undefined)
      .map((e) => (e.output as {grade: string}).grade);
    expect(grades.length).toBe(headlines.length);
    expect(grades[grades.length - 1]).toBe('tech-related');
    expect(grades.slice(0, -1).every((g) => g === 'unrelated')).toBe(true);

    const lastHeadline = (headlines[headlines.length - 1].content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(finalOutput(events)).toBe(lastHeadline);
  }, 120000);
});
