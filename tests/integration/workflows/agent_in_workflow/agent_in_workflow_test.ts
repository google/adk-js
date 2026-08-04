/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `agent_in_workflow` sample: a task-mode LlmAgent collects an
 * identity via finish_task, a node routes on it, and a second LlmAgent uses a
 * require_confirmation tool (approved here by a plain-text reply, per the CLI
 * opt-in).
 */

import {getFunctionCalls} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: agent_in_workflow (task mode + confirmation)', () => {
  it('collects identity, gates a tool on confirmation, then lists orders', async () => {
    const perTurn = await runSample({
      name: 'agent_in_workflow',
      rootAgent,
      turns: [
        'My full name is Jane Doe and my phone number is 555-123-4567.',
        'yes',
      ],
      // The find_orders tool requires confirmation; let a plain-text "yes"
      // approve it (the interactive CLI opt-in).
      runConfig: {plainTextToolConfirmation: true},
    });
    const events = allEvents(perTurn);

    // The task-mode intake agent and the instruction agent both ran.
    expect(authors(events).has('intake_agent')).toBe(true);
    expect(authors(events).has('generate_instruction')).toBe(true);

    // The confirmation-gated tool was ultimately called.
    const calledFindOrders = events
      .flatMap((e) => getFunctionCalls(e))
      .some((c) => c.name === 'find_orders');
    expect(calledFindOrders).toBe(true);
  });
});
