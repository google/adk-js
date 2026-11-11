/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `retry` sample (offline): a flaky node is retried per its
 * RetryConfig until it succeeds. Turn mirrors the Python golden
 * `contributing/samples/workflows/retry/tests/go.json`, which mocks
 * `random.random` to force exactly three attempts; here `Math.random` is
 * seeded to a value that produces the same three attempts.
 *
 * The seed cannot be chosen to reproduce Python's exact draws: the engine's
 * event-id generator draws from `Math.random` too (8 draws per event), so the
 * sample's own draws are interleaved with it.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {mulberry32} from '../_harness/rng.js';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflow sample: retry', () => {
  it('retries the failing node and reports the weather once it succeeds', async () => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(2));

    const perTurn = await runSample({
      name: 'retry',
      rootAgent,
      turns: ['go'],
      offline: true,
    });
    const events = allEvents(perTurn);

    const texts = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .filter(Boolean);

    expect(
      texts.filter((t) => t.startsWith('Getting weather... attempt')),
    ).toEqual([
      'Getting weather... attempt 1',
      'Getting weather... attempt 2',
      'Getting weather... attempt 3',
    ]);
    expect(finalOutput(events)).toBe('sunny');
    expect(texts).toContain('The weather is sunny');

    expect(events.filter((e) => e.errorCode !== undefined)).toHaveLength(0);
  }, 30000);
});
