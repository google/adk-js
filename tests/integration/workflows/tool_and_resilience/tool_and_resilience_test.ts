/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for tools in workflows, retry exhaustion, and resuming a
 * HITL interrupt raised inside a nested workflow.
 */

import {
  FunctionNode,
  FunctionTool,
  node,
  NodeContext,
  RequestInput,
  ToolNode,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  createWorkflowRunner,
  finalOutput,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — ToolNode', () => {
  it('runs a BaseTool as a node with args from an upstream node', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({a: z.number(), b: z.number()}),
      execute: async ({a, b}: {a: number; b: number}) => ({sum: a + b}),
    });
    const produceArgs = new FunctionNode('produce_args', () => ({a: 2, b: 3}));
    const wf = new Workflow({
      name: 'tool_workflow',
      edges: [['START', produceArgs, new ToolNode(addTool)]],
    });
    expect(finalOutput(await runWorkflowOnce(wf, 'go'))).toEqual({sum: 5});
  });
});

describe('workflow integration — retry exhaustion', () => {
  it('fails the workflow when a node exhausts its retries', async () => {
    let attempts = 0;
    const flaky = new FunctionNode(
      'always_fails',
      () => {
        attempts++;
        throw new Error('permanent failure');
      },
      {retryConfig: {maxAttempts: 3, initialDelay: 0.001, jitter: 0}},
    );
    const wf = new Workflow({name: 'retry_exhaust', edges: [['START', flaky]]});
    await expect(runWorkflowOnce(wf, 'go')).rejects.toThrow(
      'permanent failure',
    );
    expect(attempts).toBe(3);
  });
});

describe('workflow integration — nested workflow HITL resume', () => {
  it('resumes an interrupt raised inside a nested workflow', async () => {
    const gate = node(
      (ctx: NodeContext) => {
        const answer = ctx.resumeInputs['approve'];
        if (answer === undefined) {
          return new RequestInput({interruptId: 'approve', message: 'ok?'});
        }
        return `approved:${answer}`;
      },
      // Single-node HITL gate: re-runs on resume to read its answer.
      {name: 'gate', rerunOnResume: true},
    );
    const inner = new Workflow({name: 'inner', edges: [['START', gate]]});
    const outer = new Workflow({
      name: 'outer',
      edges: [
        [
          'START',
          inner,
          node((_c: NodeContext, i: string) => `wrapped(${i})`, {name: 'wrap'}),
        ],
      ],
    });
    const {run} = await createWorkflowRunner(outer);

    // Turn 1: the nested gate interrupts; the interrupt bubbles up.
    const turn1 = await collect(run('start'));
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);

    // Turn 2: resume; the nested gate resolves and the outer workflow finishes.
    const turn2 = await collect(
      run({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'approve',
              name: 'adk_request_input',
              response: {result: 'yes'},
            },
          },
        ],
      }),
    );
    expect(finalOutput(turn2)).toBe('wrapped(approved:yes)');
  });
});
