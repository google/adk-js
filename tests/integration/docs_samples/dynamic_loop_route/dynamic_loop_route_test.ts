/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `dynamic/loop_route` —
 * https://adk.dev/graphs/dynamic/#loop-route
 *
 * A `while` loop that keeps calling an agent until a checker is satisfied: the
 * model's answer decides how many times the graph runs. Also the sample most
 * able to pass while demonstrating nothing — given a request the linter accepts
 * first time, the loop never runs — so the assertions require a dirty first
 * pass, a fixer round, and an exit on a clean check rather than on the cap.
 */

import {describe, expect, it} from 'vitest';
import {authors, finalOutput, runRecorded} from '../_shared.js';

/** Mirrors MAX_FIX_ROUNDS in the sample: 3 rounds means at most 4 checks. */
const MAX_LINT_CHECKS = 4;

describe('docs sample: dynamic/loop_route', () => {
  it('refines until the checker is satisfied', async () => {
    const events = await runRecorded(
      'dynamic/loop_route',
      [
        'a one-line function that adds two numbers, no comments, no type annotations',
      ],
      import.meta.url,
    );

    const lintResults = events
      .filter((e) => e.author === 'lint_reviewer' && e.output !== undefined)
      .map((e) => (e.output as {findings: string}).findings);

    // A first draft the checker rejected, then a fixer round.
    expect(lintResults.length).toBeGreaterThan(1);
    expect(lintResults[0]).not.toBe('');
    expect(authors(events).has('fixer_agent')).toBe(true);

    // Exited because the code came back clean, not because it ran out of rounds.
    expect(lintResults[lintResults.length - 1]).toBe('');
    expect(lintResults.length).toBeLessThanOrEqual(MAX_LINT_CHECKS);
    expect(String(finalOutput(events))).toBeTruthy();
  });
});
