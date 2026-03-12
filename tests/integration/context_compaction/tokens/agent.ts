/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, LlmSummarizer, TokenBasedContextCompactor} from '@google/adk';
import {GeminiWithMockResponses} from '../../agents/test_case_utils.js';

// Configure a TokenBasedContextCompactor
// We use a small threshold so compaction triggers after just a couple of turns.
export const compactor = new TokenBasedContextCompactor({
  tokenThreshold: 40,
  eventRetentionSize: 2,
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
        usageMetadata: {
          promptTokenCount: 10,
          totalTokenCount: 15,
        },
      },
    ]),
  }),
});

export const rootAgent = new LlmAgent({
  name: 'compaction_agent',
  model: 'gemini-2.5-flash',
  description: 'Agent to demonstrate context compaction.',
  instruction: 'You are a helpful assistant that answers concisely.',
  contextCompactors: [compactor],
});
