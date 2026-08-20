/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for `LlmAgent` task mode as a workflow node: the agent is
 * given a `finish_task` tool and runs until it calls it; the call's arguments
 * (conforming to the agent's output schema) become the node output and feed the
 * next node. Mirrors the `agent_in_workflow` intake pattern.
 */

import {node, NodeContext, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  createWorkflowRunner,
  finalOutput,
  functionCallResponse,
  mockLlmAgent,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — LlmAgent task mode', () => {
  it('runs until finish_task and promotes its args to the node output', async () => {
    const intake = mockLlmAgent(
      {
        name: 'intake_agent',
        mode: 'task',
        instruction: 'Collect the patient name and phone number.',
        outputSchema: z.object({name: z.string(), phoneNumber: z.string()}),
        outputKey: 'identity',
      },
      [
        functionCallResponse('finish_task', {
          name: 'Jane Doe',
          phoneNumber: '555-1234',
        }),
      ],
    );

    const check = node(
      (_ctx: NodeContext, identity: {name: string; phoneNumber: string}) =>
        `checked:${identity.name} (${identity.phoneNumber})`,
      {name: 'check'},
    );

    const wf = new Workflow({
      name: 'task_wf',
      edges: [['START', intake, check]],
    });

    const {run} = await createWorkflowRunner(wf);
    const events = await collect(run('Hi, I am Jane Doe, 555-1234.'));

    // finish_task args flowed to `check` as its input.
    expect(finalOutput(events)).toBe('checked:Jane Doe (555-1234)');
    // The finish_task args were also promoted to the node output.
    expect(
      events.some(
        (e) =>
          typeof e.output === 'object' &&
          e.output !== null &&
          (e.output as {name?: string}).name === 'Jane Doe',
      ),
    ).toBe(true);
  });
});
