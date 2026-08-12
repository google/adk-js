/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/sequence_route` —
 *
 * https://adk.dev/graphs/dynamic/#sequence-route Three sequential
 * `ctx.runNode()` calls: the city the first node invents has to survive the
 * lookup and reach the report, in that order.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

/** Index of the first event authored by `author` (-1 when absent). */
function indexOfAuthor(events: Event[], author: string): number {
  return events.findIndex((e) => e.author === author);
}

describe('docs sample: dynamic/sequence_route', () => {
  it('carries one city through all three steps, in order', async () => {
    const perTurn = await runSample({
      name: 'docs_dynamic_sequence_route',
      rootAgent,
      turns: ['go'],
    });
    const events = allEvents(perTurn);

    const cityTime = finalOutput(
      events.filter((e) => e.author === 'city_time_function'),
    ) as {city?: string; timeInfo?: string};
    expect(cityTime?.city).toBeTruthy();
    expect(cityTime?.timeInfo).toBe('10:10 AM');

    // The city the generator invented is the one reported at the end.
    expect(String(finalOutput(events))).toContain(cityTime.city!);

    expect(indexOfAuthor(events, 'city_generator_agent')).toBeLessThan(
      indexOfAuthor(events, 'city_time_function'),
    );
    expect(indexOfAuthor(events, 'city_time_function')).toBeLessThan(
      indexOfAuthor(events, 'city_report_agent'),
    );
  });
});
