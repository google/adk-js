/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test mirroring the Python `workflows/sequence` sample: two LLM
 * agents chained in a workflow, with model responses loaded from a JSON fixture.
 */

import {Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './sequence.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — sequence of LLM agents', () => {
  it('chains two LLM agents, feeding the first output into the second', async () => {
    const generateFruit = mockLlmAgent(
      {
        name: 'generate_fruit_agent',
        instruction:
          'Return the name of a random fruit. Return only the name, nothing else.',
      },
      responses['generate_fruit_agent'],
    );
    const generateBenefit = mockLlmAgent(
      {
        name: 'generate_benefit_agent',
        instruction: 'Tell me a health benefit about the specified fruit.',
      },
      responses['generate_benefit_agent'],
    );

    const wf = new Workflow({
      name: 'sequence_llm',
      edges: [['START', generateFruit, generateBenefit]],
    });

    const events = await runWorkflowOnce(wf, 'Give me a fruit fact');

    // The final workflow output is the second agent's response.
    expect(finalOutput(events)).toBe('Apples are rich in fiber.');
    // Both agents contributed events.
    expect(events.some((e) => e.author === 'generate_fruit_agent')).toBe(true);
    expect(events.some((e) => e.author === 'generate_benefit_agent')).toBe(
      true,
    );
  });
});
