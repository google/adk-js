/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `agent_in_workflow` sample: a task-mode LlmAgent collects an
 * identity via finish_task, a node routes on it, and a second LlmAgent uses a
 * require_confirmation tool. Scenarios mirror the Python goldens
 * `contributing/samples/workflows/agent_in_workflow/tests/*.json`.
 */

import {getFunctionCalls} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {answer, isPaused, joinedText} from '../_harness/hitl.js';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const approve = answer('adk_request_confirmation', {
  confirmed: true,
  payload: {},
});
const decline = answer('adk_request_confirmation', {
  confirmed: false,
  payload: {},
});

describe('workflow sample: agent_in_workflow (task mode + confirmation)', () => {
  it('collects the identity, greets, and gates the tool on confirmation', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: ['I am Jane Doe, my phone number is 555-1234'],
    });
    const [turn1] = perTurn;

    expect(
      turn1.flatMap((e) => getFunctionCalls(e)).map((c) => c.name),
    ).toContain('finish_task');
    expect(authors(turn1).has('intake_agent')).toBe(true);

    expect(turn1.map((e) => e.route).filter(Boolean)).toEqual([]);
    expect(joinedText(turn1)).toContain(
      'Hello Jane Doe! Let me look up your orders.',
    );

    const calls = turn1.flatMap((e) => getFunctionCalls(e)).map((c) => c.name);
    expect(calls).toContain('find_orders');
    expect(calls).toContain('adk_request_confirmation');
    expect(isPaused(turn1)).toBe(true);
  }, 120000);

  it('collects the identity across several turns', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: ['go', 'Jane Doe', '555-1234'],
    });
    const [turn1, turn2, turn3] = perTurn;

    for (const turn of [turn1, turn2]) {
      expect(authors(turn).has('intake_agent')).toBe(true);
      expect(authors(turn).has('check_identity')).toBe(false);
    }

    expect(
      turn3.flatMap((e) => getFunctionCalls(e)).map((c) => c.name),
    ).toContain('finish_task');
    expect(joinedText(turn3)).toContain(
      'Hello Jane Doe! Let me look up your orders.',
    );
    expect(authors(turn3).has('generate_instruction')).toBe(true);
  }, 180000);

  it('routes back to intake when the name does not match', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: ['My name is John Doe', '555-1234', 'Jane Doe, 555-1234'],
    });
    const events = allEvents(perTurn);

    expect(events.map((e) => e.route).filter(Boolean)).toContain('retry');
    expect(joinedText(events)).toContain(
      'Could not find matching records for John Doe.',
    );

    expect(
      events.filter((e) => e.author === 'check_identity').length,
    ).toBeGreaterThanOrEqual(2);
    expect(joinedText(events)).toContain(
      'Hello Jane Doe! Let me look up your orders.',
    );
    expect(authors(events).has('generate_instruction')).toBe(true);
  }, 180000);

  it('lists the orders once the tool confirmation is approved', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: ['I am Jane Doe, my phone number is 555-1234', approve],
    });
    expect(joinedText(allEvents(perTurn))).toContain(
      'CBC (Complete Blood Count)',
    );
  }, 120000);

  it('reports the rejection when the confirmation is declined', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: ['I am Jane Doe, my phone number is 555-1234', decline],
    });
    expect(joinedText(allEvents(perTurn))).toContain('rejected');
  }, 120000);
});
