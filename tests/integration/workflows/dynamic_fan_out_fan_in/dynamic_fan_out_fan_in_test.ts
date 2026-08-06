/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `dynamic_fan_out_fan_in` sample: an orchestrator splits a
 * comma-separated input, fans out a worker agent per topic via `ctx.runNode()`
 * (concurrent, closure-captured), then aggregates. Exercises both the global
 * model seam and the fingerprint matcher under concurrency.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: dynamic_fan_out_fan_in', () => {
  it('fans a worker agent out across topics and aggregates', async () => {
    const perTurn = await runSample({
      name: 'dynamic_fan_out_fan_in',
      rootAgent,
      turns: ['space, oceans, volcanoes'],
    });
    const events = allEvents(perTurn);

    // The worker agent ran once per topic (concurrent, distinct fingerprints).
    const generatorEvents = events.filter((e) => e.author === 'generator');
    expect(generatorEvents.length).toBeGreaterThanOrEqual(3);

    // The orchestrator emitted an aggregated table over all topics.
    const orchestratorText = events
      .filter((e) => e.author === 'orchestrator')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(orchestratorText).toContain('Aggregated Headlines');
  });
});
