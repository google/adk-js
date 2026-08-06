/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `node_as_tool` sample: an LlmAgent uses a Workflow and a node as
 * tools (auto-wrapped as NodeTools). The discount node raises a RequestInput
 * mid-tool-call (HITL); the next turn answers it and the tool result flows back
 * to the model.
 */

import {getFunctionCalls, getFunctionResponses} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {allEvents, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: node_as_tool (HITL mid-tool)', () => {
  it('calls node/workflow tools and resumes a mid-tool interrupt', async () => {
    // Turn 2 answers the node-tool's RequestInput (fixed interruptId).
    const resume: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'confirm_vip_discount',
            name: 'adk_request_input',
            response: {result: 'yes'},
          },
        },
      ],
    };

    const perTurn = await runSample({
      name: 'node_as_tool',
      rootAgent,
      turns: ['Look up user u123 and tell me my discount.', resume],
    });
    const [turn1, turn2] = perTurn;

    // Turn 1: the model calls the lookup tool and the discount node-tool, which
    // raises a RequestInput interrupt.
    const turn1Calls = turn1
      .flatMap((e) => getFunctionCalls(e))
      .map((c) => c.name);
    expect(turn1Calls).toContain('customer_lookup_workflow');
    expect(turn1Calls).toContain('adk_request_input');

    // Turn 2: the node-tool re-runs with the answer and returns the VIP discount.
    const discount = allEvents([turn2])
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'calculate_discount');
    expect(JSON.stringify(discount?.response)).toContain('20% off');
  });
});
