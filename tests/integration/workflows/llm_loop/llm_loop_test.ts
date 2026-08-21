/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: an imperative loop driven by an LLM agent's decision
 * ("continue"/"done"), with model responses from a JSON fixture.
 */

import {Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {RawGenerateContentResponse} from '../../test_case_utils.js';
import {
  finalOutput,
  mockLlmAgent,
  runWorkflowOnce,
} from '../_harness/workflow_test_utils.js';
import modelResponses from './llm_loop.model_responses.json' with {type: 'json'};

const responses = modelResponses as Record<
  string,
  RawGenerateContentResponse[]
>;

describe('workflow integration — LLM-driven loop', () => {
  it('loops until the LLM agent decides to stop', async () => {
    const decider = mockLlmAgent(
      {
        name: 'decider',
        instruction: 'Reply "continue" to keep going or "done" to stop.',
      },
      responses['decider'],
    );

    const wf = new Workflow({
      name: 'llm_loop',
      dynamicEntry: async (ctx) => {
        let rounds = 0;
        for (;;) {
          const decision = await ctx.runNode(decider, `round ${rounds}`, {
            runId: `d${rounds}`,
          });
          rounds++;
          if (String(decision.output).includes('done')) {
            break;
          }
          if (rounds > 5) {
            break; // safety valve
          }
        }
        return {rounds};
      },
    });

    // "continue", "continue", "done" -> 3 rounds.
    expect(finalOutput(await runWorkflowOnce(wf, 'start'))).toEqual({
      rounds: 3,
    });
  });
});
