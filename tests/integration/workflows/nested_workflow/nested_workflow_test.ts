/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `nested_workflow` sample: a sub-Workflow (find name -> bio) runs
 * in parallel with an agent, joined and aggregated.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: nested_workflow', () => {
  it('runs a sub-workflow in parallel with an agent, then aggregates', async () => {
    const perTurn = await runSample({
      name: 'nested_workflow',
      rootAgent,
      turns: ['1955'],
    });
    const events = allEvents(perTurn);

    // The sub-workflow's two agents and the parallel agent all ran.
    expect(authors(events).has('find_name')).toBe(true);
    expect(authors(events).has('generate_bio')).toBe(true);
    expect(authors(events).has('find_historical_event')).toBe(true);

    // The aggregate node emitted a combined report referencing the year.
    const aggregateText = events
      .filter((e) => e.author === 'aggregate_results')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ');
    expect(aggregateText).toContain('1955');
    expect(aggregateText).toContain('Famous Person Bio');
  });
});
