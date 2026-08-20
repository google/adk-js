/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: a ParallelWorker mapping an LLM agent over a list of items,
 * with model responses from a JSON fixture.
 */

import {node, ParallelWorker, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './parallel_llm.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — ParallelWorker over an LLM agent', () => {
  it('maps an LLM agent across a list of items', async () => {
    const classifier = mockLlmAgent(
      {name: 'classifier', instruction: 'Classify the item.'},
      responses['classifier'],
    );

    // Produce the list inside the workflow, then map the agent across it.
    const produce = node((): string[] => ['alpha', 'beta', 'gamma'], {
      name: 'produce',
    });
    const worker = new ParallelWorker(classifier, {maxParallelWorkers: 1});

    const wf = new Workflow({
      name: 'parallel_llm',
      edges: [['START', produce, worker]],
    });

    const output = finalOutput(await runWorkflowOnce(wf, 'go')) as string[];
    expect(output).toHaveLength(3);
    expect(output).toEqual(['processed', 'processed', 'processed']);
  });
});
