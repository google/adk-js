/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `loop` sample: a graph-level cycle that generates a headline,
 * grades it, and routes back to generation until it is graded tech-related.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: loop', () => {
  it('generates and grades headlines around the cyclic edge', async () => {
    const perTurn = await runSample({
      name: 'loop',
      rootAgent,
      turns: ['quantum computing'],
    });
    const events = allEvents(perTurn);

    // Both agents in the cycle ran at least once.
    expect(authors(events).has('generate_headline')).toBe(true);
    expect(authors(events).has('evaluate_headline')).toBe(true);

    // A route was emitted by the routing node (either back to generate, or out).
    const routed = events.some((e) => e.route !== undefined);
    expect(routed).toBe(true);
  });
});
