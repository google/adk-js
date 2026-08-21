/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for LLM agents embedded in workflows (model responses from
 * a JSON fixture): a mixed function/agent pipeline, and multi-agent
 * orchestration driven imperatively via ctx.runNode.
 */

import {FunctionNode, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './agent_pipeline.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — mixed function/agent pipeline', () => {
  it('runs function -> LLM agent -> function, threading outputs', async () => {
    const preprocess = new FunctionNode('preprocess', (_c, input: string) =>
      input.toUpperCase(),
    );
    const summarizer = mockLlmAgent(
      {name: 'summarizer', instruction: 'Summarize the provided text.'},
      responses['summarizer'],
    );
    const postprocess = new FunctionNode(
      'postprocess',
      (_c, input: string) => `[${input}]`,
    );

    const wf = new Workflow({
      name: 'agent_pipeline',
      edges: [['START', preprocess, summarizer, postprocess]],
    });

    const events = await runWorkflowOnce(wf, 'the quarterly report');
    expect(finalOutput(events)).toBe('[Summary: the report is positive.]');
    expect(events.some((e) => e.author === 'summarizer')).toBe(true);
  });
});

describe('workflow integration — multi-agent orchestration (LLM)', () => {
  it('coordinates two LLM agents via ctx.runNode', async () => {
    const researcher = mockLlmAgent(
      {name: 'researcher', instruction: 'Research the given topic.'},
      responses['researcher'],
    );
    const writer = mockLlmAgent(
      {name: 'writer', instruction: 'Write a report from the research.'},
      responses['writer'],
    );

    const wf = new Workflow({
      name: 'coordinator',
      dynamicEntry: async (ctx, input) => {
        const research = await ctx.runNode(researcher, input);
        const report = await ctx.runNode(writer, research.output);
        return {research: research.output, report: report.output};
      },
    });

    const events = await runWorkflowOnce(wf, 'ADK workflows');
    expect(finalOutput(events)).toEqual({
      research: 'Findings: A, B, C.',
      report: 'Report drafted from the findings.',
    });
    expect(events.some((e) => e.author === 'researcher')).toBe(true);
    expect(events.some((e) => e.author === 'writer')).toBe(true);
  });
});
