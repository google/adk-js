/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `loop_self` sample (offline): a node routes back to itself
 * until its random guess matches the target. Turn mirrors the Python golden
 * `contributing/samples/workflows/loop_self/tests/3.json`, which mocks the RNG
 * to a fixed sequence; here `Math.random` is replaced by a seeded PRNG.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {mulberry32} from '../_harness/rng.js';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workflow sample: loop_self', () => {
  it('guesses repeatedly around the self-edge until it is correct', async () => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(1));

    const perTurn = await runSample({
      name: 'loop_self',
      rootAgent,
      turns: ['3'],
      offline: true,
    });
    const events = allEvents(perTurn);

    expect(authors(events).has('guess_number')).toBe(true);

    const texts = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .filter(Boolean);
    const guesses = texts.filter((t) => t.startsWith('Guessing '));

    expect(guesses.length).toBeGreaterThan(1);
    expect(texts).toContain('Correct!');
    const wrongRoutes = events.filter((e) => e.route === 'guessed_wrong');
    expect(wrongRoutes).toHaveLength(guesses.length - 1);

    expect(guesses[guesses.length - 1]).toBe('Guessing 3...');
  });

  it('rejects a non-numeric input the way Python int() does', async () => {
    await expect(
      runSample({
        name: 'loop_self',
        rootAgent,
        turns: ['3abc'],
        offline: true,
      }),
    ).rejects.toThrow(/invalid literal for int\(\)/);
  });
});
