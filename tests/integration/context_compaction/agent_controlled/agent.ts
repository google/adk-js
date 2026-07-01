/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentControlledContextCompactor,
  ConsolidateContextTool,
  LlmAgent,
  LlmSummarizer,
} from '@google/adk';
import {GeminiWithMockResponses} from '../../test_case_utils.js';

export const compactor = new AgentControlledContextCompactor({
  summarizer: new LlmSummarizer({
    llm: new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Compacted summary of the conversation.'}],
            },
          },
        ],
      },
    ]),
  }),
});

export const rootAgent = new LlmAgent({
  name: 'agent_controlled_compaction_agent',
  model: 'gemini-2.5-flash',
  description: 'Agent to demonstrate agent-controlled context compaction.',
  instruction: 'You are a helpful assistant.',
  tools: [new ConsolidateContextTool()],
  contextCompactors: [compactor],
});
