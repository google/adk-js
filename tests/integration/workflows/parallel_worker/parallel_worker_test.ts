/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `samples/workflows/parallel_worker` agent with recorded model
 * responses. The per-item worker LlmAgent fires several model calls
 * concurrently, so this exercises the fingerprint matcher's order/concurrency
 * independence.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: parallel_worker', () => {
  it('maps a worker agent across items concurrently and aggregates', async () => {
    const perTurn = await runSample({
      name: 'parallel_worker',
      rootAgent,
      turns: ['databases'],
    });
    const events = allEvents(perTurn);

    // The generator agent and the aggregate node ran.
    expect(authors(events).has('find_related_topics')).toBe(true);
    expect(authors(events).has('aggregate')).toBe(true);

    // The worker agent ran for multiple items (concurrent model calls, each
    // matched to its own recorded response by request fingerprint).
    const explainEvents = events.filter((e) => e.author === 'explain_topic');
    expect(explainEvents.length).toBeGreaterThanOrEqual(2);

    // The aggregate node emits a human-readable summary (a message, not output).
    const aggregateText = events
      .filter((e) => e.author === 'aggregate')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(aggregateText.length).toBeGreaterThan(0);
  });
});
