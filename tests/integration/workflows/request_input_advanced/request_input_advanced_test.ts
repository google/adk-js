/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `request_input_advanced` sample: an agent extracts a structured
 * time-off request; short requests are auto-approved and longer ones pause for a
 * manager decision declared by a response schema. Scenarios mirror the Python
 * golden
 * `contributing/samples/workflows/request_input_advanced/tests/2_sick_days.json`.
 */

import {getFunctionCalls} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {answer, isPaused, joinedText} from '../_harness/hitl.js';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: request_input_advanced (structured HITL)', () => {
  it('auto-approves a single day without asking the manager', async () => {
    const perTurn = await runSample({
      name: 'request_input_advanced',
      rootAgent,
      turns: ['1 sick day'],
    });
    const [turn1] = perTurn;

    expect(authors(turn1).has('process_request')).toBe(true);
    const request = turn1
      .map((e) => e.actions?.stateDelta ?? {})
      .find((d) => 'request' in d)?.['request'] as {
      days: number;
      reason: string;
    };
    expect(request.days).toBe(1);
    expect(request.reason.toLowerCase()).toContain('sick');

    expect(isPaused(turn1)).toBe(false);
    expect(joinedText(turn1)).toContain(
      'Time Off Approved! 1 out of 1 days granted.',
    );
  }, 120000);

  it('pauses for a manager decision, advertising the response schema', async () => {
    const perTurn = await runSample({
      name: 'request_input_advanced',
      rootAgent,
      turns: ['2 sick days'],
    });
    const [turn1] = perTurn;

    expect(isPaused(turn1)).toBe(true);
    const call = turn1
      .flatMap((e) => getFunctionCalls(e))
      .find((c) => c.name === 'adk_request_input');
    expect(call?.args?.['message']).toBe(
      'Please review this time off request.',
    );
    expect(JSON.stringify(call?.args?.['payload'])).toContain('"days":2');
    expect(JSON.stringify(call?.args)).toContain('approved_days');
    expect(JSON.stringify(call?.args)).toContain(
      'The structured response we expect back from the human manager.',
    );
  }, 120000);

  it.skip('renders the decision from a structured resume', async () => {
    const perTurn = await runSample({
      name: 'request_input_advanced',
      rootAgent,
      turns: [
        '2 sick days',
        answer('adk_request_input', {result: '{"approved": true}'}),
      ],
    });
    const [, turn2] = perTurn;

    expect(joinedText(turn2)).toContain(
      'Time Off Approved! 2 out of 2 days granted.',
    );
    expect(isPaused(turn2)).toBe(false);
  }, 120000);
});
