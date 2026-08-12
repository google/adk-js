/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/sequence/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Simple sequential workflow with LLM agents: the first agent names a random
 * fruit, and its output feeds the second agent, which describes a health benefit
 * of that fruit. Faithful port of Python
 * `contributing/samples/workflows/sequence`.
 *
 * REQUIRES an API key (both nodes call a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/sequence/agent.ts
 */

import {LlmAgent, Workflow} from '@google/adk';

const generateFruitAgent = new LlmAgent({
  name: 'generate_fruit_agent',
  model: 'gemini-2.5-flash',
  instruction: `Return the name of a random fruit.
      Return only the name, nothing else.`,
});

const generateBenefitAgent = new LlmAgent({
  name: 'generate_benefit_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Tell me a health benefit about the specified fruit.',
});

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [['START', generateFruitAgent, generateBenefitAgent]],
});
