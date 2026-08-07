/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `loop_self` sample (offline): a node routes back to itself until
 * it guesses the target number. `Math.random` is seeded for reproducibility.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {mulberry32} from '../_harness/rng.js';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: loop_self', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loops back to itself until it guesses the target', async () => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(1));

    const perTurn = await runSample({
      name: 'loop_self',
      rootAgent,
      turns: ['7'],
      offline: true,
    });
    const events = allEvents(perTurn);

    // The self-looping node ran (guessing), and eventually announced success.
    expect(authors(events).has('guess_number')).toBe(true);
    const text = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(text).toContain('Correct!');
  });
});
