/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `dynamic/sequence_route` —
 * https://adk.dev/graphs/dynamic/#sequence-route
 *
 * Three sequential `ctx.runNode()` calls. The city the first node invents has
 * to survive the lookup and reach the report, in that order — which is the
 * whole claim, and what is asserted here.
 */

import {describe, expect, it} from 'vitest';
import {finalOutput, indexOfAuthor, outputOf, runRecorded} from '../_shared.js';

describe('docs sample: dynamic/sequence_route', () => {
  it('carries one city through all three steps, in order', async () => {
    const events = await runRecorded(
      'dynamic/sequence_route',
      ['go'],
      import.meta.url,
    );

    const cityTime = outputOf(events, 'city_time_function') as {
      city?: string;
      timeInfo?: string;
    };
    expect(cityTime?.city).toBeTruthy();
    expect(cityTime?.timeInfo).toBe('10:10 AM');

    expect(String(finalOutput(events))).toContain(cityTime.city!);

    expect(indexOfAuthor(events, 'city_generator_agent')).toBeLessThan(
      indexOfAuthor(events, 'city_time_function'),
    );
    expect(indexOfAuthor(events, 'city_time_function')).toBeLessThan(
      indexOfAuthor(events, 'city_report_agent'),
    );
  });
});
