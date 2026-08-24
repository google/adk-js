/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/legacy_workflows/non_llm_sequential.
 *
 * The smallest possible `SequentialAgent`: two LLM agents that each say one
 * word, run back to back. The Python sub-agents omit `model`, which the shim
 * pins; TS has no such default, so the pinned model is set explicitly.
 */
import {LlmAgent, SequentialAgent} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

const subAgent1 = new LlmAgent({
  name: 'sub_agent_1',
  model: PARITY_MODEL,
  description: 'No.1 sub agent.',
  instruction: 'JUST SAY 1.',
});

const subAgent2 = new LlmAgent({
  name: 'sub_agent_2',
  model: PARITY_MODEL,
  description: 'No.2 sub agent.',
  instruction: 'JUST SAY 2.',
});

const sequentialAgent = new SequentialAgent({
  name: 'sequential_agent',
  subAgents: [subAgent1, subAgent2],
});

export const rootAgent = sequentialAgent;
