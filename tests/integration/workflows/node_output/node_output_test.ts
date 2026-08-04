/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `node_output` sample: raw-string, Event({output}), and a
 * schema-typed LlmAgent output consumed by a downstream node.
 */

import {describe, expect, it} from 'vitest';
import {
  allEvents,
  authors,
  finalOutput,
  runSample,
} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('workflow sample: node_output', () => {
  it('threads a schema-typed LLM output into the consuming node', async () => {
    const perTurn = await runSample({
      name: 'node_output',
      rootAgent,
      turns: ['ocean exploration'],
    });
    const events = allEvents(perTurn);

    // The schema-typed LLM node ran.
    expect(authors(events).has('generate_pydantic_output')).toBe(true);

    // The final node rendered the structured fields it received.
    const output = finalOutput(events);
    expect(typeof output).toBe('string');
    expect(output as string).toContain('Received Pydantic Model!');
    expect(output as string).toContain('Title:');
  });
});
