/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/sequence.
 *
 * A three-or-more element edge tuple is an unconditional chain in both
 * runtimes, so the graph translates one-to-one: same node names, same
 * instruction text, same order.
 */
import {LlmAgent, Workflow} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

const generateFruitAgent = new LlmAgent({
  name: 'generate_fruit_agent',
  model: PARITY_MODEL,
  instruction: `Return the name of a random fruit.
      Return only the name, nothing else.`,
});

const generateBenefitAgent = new LlmAgent({
  name: 'generate_benefit_agent',
  model: PARITY_MODEL,
  instruction: `Tell me a health benefit about the specified fruit.`,
});

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', generateFruitAgent, generateBenefitAgent]],
});
