/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interactive resume: a HITL/auth pause can be resumed by a plain-text reply
 * (not just a structured function response), which is what enables `adk run` to
 * drive HITL workflows by typing a message.
 */

import {
  createEvent,
  node,
  NodeContext,
  RequestInput,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  collect,
  createWorkflowRunner,
  finalOutput,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — plain-text interactive resume', () => {
  it('resumes a HITL node from a plain-text reply (preserving original input)', async () => {
    const gate = node(
      (ctx: NodeContext, input: string) => {
        const reply = ctx.resumeInputs['review'];
        if (reply === undefined) {
          return new RequestInput({interruptId: 'review', message: 'ok?'});
        }
        return createEvent({output: `input=${input} reply=${reply}`});
      },
      // Single-node HITL gate: re-runs on resume to read its reply.
      {name: 'gate', rerunOnResume: true},
    );
    const wf = new Workflow({
      name: 'plain_text_resume',
      edges: [['START', gate]],
    });
    const {run} = await createWorkflowRunner(wf);

    // Turn 1: interrupts.
    const turn1 = await collect(run('hello'));
    expect(
      turn1.some((e) =>
        (e.content?.parts ?? []).some(
          (p) => p.functionCall?.name === 'adk_request_input',
        ),
      ),
    ).toBe(true);

    // Turn 2: a plain-text reply resumes the pending interrupt.
    const turn2 = await collect(run('approve'));
    expect(finalOutput(turn2)).toBe('input=hello reply=approve');
  });
});
