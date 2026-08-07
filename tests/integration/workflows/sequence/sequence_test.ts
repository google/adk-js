/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `samples/workflows/sequence` agent with recorded model
 * responses: two LlmAgents chained in a workflow.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: sequence', () => {
  it('chains two LLM agents, surfacing the second agent output', async () => {
    const perTurn = await runSample({
      name: 'sequence',
      rootAgent,
      turns: ['Give me a fruit fact'],
    });
    const events = allEvents(perTurn);

    // Both agents in the chain ran.
    expect(authors(events).has('generate_fruit_agent')).toBe(true);
    expect(authors(events).has('generate_benefit_agent')).toBe(true);

    // The workflow's final output is a non-empty string (the second response).
    const output = finalOutput(events);
    expect(typeof output).toBe('string');
    expect((output as string).length).toBeGreaterThan(0);
  });
});
