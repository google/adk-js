/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `retry` sample (offline): a node fails randomly (~70%) and is
 * retried per its RetryConfig. `Math.random` is seeded so the run is
 * reproducible (and eventually succeeds within maxAttempts).
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {mulberry32} from '../_harness/rng.js';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: retry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries the flaky node until it succeeds', async () => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(7));

    const perTurn = await runSample({
      name: 'retry',
      rootAgent,
      turns: ['what is the weather?'],
      offline: true,
    });
    const events = allEvents(perTurn);

    // The node was attempted more than once (a retry happened) ...
    const attempts = events.filter((e) =>
      (e.content?.parts ?? []).some((p) => p.text?.includes('Getting weather')),
    );
    expect(attempts.length).toBeGreaterThanOrEqual(2);

    // ... and ultimately succeeded, feeding the reporter node.
    expect(authors(events).has('report_weather')).toBe(true);
    const text = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(text).toContain('The weather is sunny');
  });
});
