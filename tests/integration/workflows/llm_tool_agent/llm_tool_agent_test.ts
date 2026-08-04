/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: an LLM agent that calls a tool, embedded as a workflow
 * node. The mocked model first returns a function call, then a final answer
 * after the tool runs.
 */

import {FunctionTool, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './llm_tool_agent.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — LLM agent with tool calling', () => {
  it('runs a tool-calling agent as a workflow node', async () => {
    let toolCalled = false;
    const lookup = new FunctionTool({
      name: 'lookup',
      description: 'Looks up a value by key.',
      parameters: z.object({key: z.string()}),
      execute: async ({key}: {key: string}) => {
        toolCalled = true;
        return {key, value: 42};
      },
    });

    const assistant = mockLlmAgent(
      {
        name: 'assistant',
        instruction: 'Use the lookup tool to answer.',
        tools: [lookup],
      },
      responses['assistant'],
    );

    const wf = new Workflow({
      name: 'llm_tool_agent',
      edges: [['START', assistant]],
    });

    const events = await runWorkflowOnce(wf, 'What is the answer?');

    expect(toolCalled).toBe(true);
    expect(finalOutput(events)).toBe('The looked-up value is 42.');
    // The tool call and its response both appear in the event stream.
    expect(
      events.some((e) =>
        (e.content?.parts ?? []).some((p) => p.functionCall?.name === 'lookup'),
      ),
    ).toBe(true);
    expect(
      events.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionResponse?.name === 'lookup',
        ),
      ),
    ).toBe(true);
  });
});
