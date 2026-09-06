/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const LEGACY_WORKFLOW_CASES: ParityCase[] = [
  {
    // Both sub-agents answer with a single digit, so any turn drives the whole
    // sequence; what is being compared is that both runtimes run sub_agent_1
    // and then sub_agent_2 for one user turn.
    id: 'legacy_non_llm_sequential',
    family: 'legacy_workflows',
    pySample: 'legacy_workflows/non_llm_sequential',
    tsAgent: 'legacy_workflows/non_llm_sequential',
    queries: ['hi'],
  },
  {
    // No upstream replay for this one. The query has to mention both stages
    // because the SequentialAgent runs prime_agent whether or not it was asked
    // to, and its input is the same conversation roll_agent saw.
    id: 'legacy_simple_sequential_agent',
    family: 'legacy_workflows',
    pySample: 'legacy_workflows/simple_sequential_agent',
    tsAgent: 'legacy_workflows/simple_sequential_agent',
    queries: ['Roll a 20 sided dice and check if the result is prime.'],
  },
  {
    // The two prompts upstream `main.py` runs, also listed in the README.
    // Every stage writes its model text to state, so all three output keys
    // hold free-form LLM output and are compared for presence, not value.
    id: 'legacy_workflow_agent_seq',
    family: 'legacy_workflows',
    pySample: 'legacy_workflows/workflow_agent_seq',
    tsAgent: 'legacy_workflows/workflow_agent_seq',
    queries: [
      'Write a python function to do quicksort.',
      'Write another python function to do bubble sort.',
    ],
    volatileStateKeys: ['generated_code', 'review_comments', 'refactored_code'],
  },
];
