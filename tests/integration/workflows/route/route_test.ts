/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `route` sample: an agent classifies the input and a routing node
 * dispatches to the matching branch. Turn and expectations mirror the Python
 * golden `contributing/samples/workflows/route/tests/who_are_you.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: route', () => {
  it('classifies the input and runs only the matching branch', async () => {
    const perTurn = await runSample({
      name: 'route',
      rootAgent,
      turns: ['who are you'],
    });
    const events = allEvents(perTurn);

    const deltas = events.map((e) => e.actions?.stateDelta ?? {});
    expect(deltas).toContainEqual({input: 'who are you'});

    const category = deltas.find((d) => 'category' in d)?.['category'];
    expect(category).toEqual({category: 'question'});

    const routes = events.map((e) => e.route).filter((r) => r !== undefined);
    expect(routes).toEqual(['question']);

    const who = authors(events);
    expect(who.has('answer_question')).toBe(true);
    expect(who.has('comment_on_statement')).toBe(false);
    expect(who.has('handle_other')).toBe(false);
  });
});
