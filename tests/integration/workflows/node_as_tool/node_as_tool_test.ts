/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `node_as_tool` sample: an LlmAgent uses a Workflow and a node as
 * tools (auto-wrapped as NodeTools). The discount node raises a RequestInput
 * mid-tool-call (HITL); the next turn answers it and the tool result flows back
 * to the model. Turns and expectations mirror the Python golden
 * `contributing/samples/workflows/node_as_tool/tests/go.json`, including its
 * `{"text": "yes"}` reply shape and the App-level resumability the sample needs.
 */

import {getFunctionCalls, getFunctionResponses} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {answer, joinedText} from '../_harness/hitl.js';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {app, rootAgent} from './agent.js';

describe('workflow sample: node_as_tool (HITL mid-tool)', () => {
  it('calls node/workflow tools and resumes a mid-tool interrupt', async () => {
    const perTurn = await runSample({
      name: 'node_as_tool',
      rootAgent,
      app,
      turns: [
        'Look up user c123 and tell me my discount.',
        answer('adk_request_input', {text: 'yes'}),
      ],
    });
    const [turn1, turn2] = perTurn;

    const turn1Calls = turn1
      .flatMap((e) => getFunctionCalls(e))
      .map((c) => c.name);
    expect(turn1Calls).toContain('customer_lookup_workflow');
    expect(turn1Calls).toContain('adk_request_input');

    const lookup = turn1
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'customer_lookup_workflow');
    expect(JSON.stringify(lookup?.response)).toContain('Verified VIP Member');
    expect(JSON.stringify(lookup?.response)).toContain('user_id');

    expect(joinedText(turn1)).toContain(
      "Checking discount rules for tier 'Verified VIP Member'...",
    );

    // Turn 2: the node-tool re-runs with the answer and returns the VIP discount.
    const discount = allEvents([turn2])
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'calculate_discount');
    expect(JSON.stringify(discount?.response)).toContain('20% off');
  }, 120000);
});
