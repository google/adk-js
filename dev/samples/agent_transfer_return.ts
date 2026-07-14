/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {LlmAgent} from '@google/adk';

const subAgent = new LlmAgent({
  name: 'sub_agent',
  model: 'gemini-3.5-flash',
  instruction: `You are a sub-agent. Reply to the user's greeting.`,
  description: 'A sub-agent that returns to root',
});

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-3.5-flash',
  instruction: `You are the root agent. For any greeting, transfer to sub_agent.`,
  subAgents: [subAgent],
});
