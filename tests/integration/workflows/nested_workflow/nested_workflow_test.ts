/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `nested_workflow` sample: a sub-Workflow runs as one node
 * alongside an agent, joined and aggregated. Turn and expectations mirror the
 * Python golden `contributing/samples/workflows/nested_workflow/tests/1984.json`.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: nested_workflow', () => {
  it('runs a sub-workflow and an agent in parallel and aggregates them', async () => {
    const perTurn = await runSample({
      name: 'nested_workflow',
      rootAgent,
      turns: ['1984'],
    });
    const events = allEvents(perTurn);

    expect(events.map((e) => e.actions?.stateDelta ?? {})).toContainEqual({
      year: '1984',
    });

    const who = authors(events);
    expect(who.has('find_name')).toBe(true);
    expect(who.has('generate_bio')).toBe(true);
    expect(who.has('find_historical_event')).toBe(true);

    const join = events.find(
      (e) => e.author === 'join_for_aggregation' && e.output !== undefined,
    );
    expect(Object.keys(join?.output as object).sort()).toEqual([
      'find_famous_person',
      'find_historical_event',
    ]);

    const text = events
      .filter((e) => e.author === 'aggregate_results')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(text).toContain('# Year: 1984');
    expect(text).toContain('## Famous Person Bio:');
    expect(text).toContain('## Historical Event:');
  });

  it('rejects an input with no 4-digit year', async () => {
    await expect(
      runSample({
        name: 'nested_workflow',
        rootAgent,
        turns: ['sometime in the eighties'],
      }),
    ).rejects.toThrow('Invalid year format.');
  });
});
