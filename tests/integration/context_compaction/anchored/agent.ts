/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AnchoredContextCompactor, LlmAgent, LlmSummarizer} from '@google/adk';
import {GeminiWithMockResponses} from '../../test_case_utils.js';

export const compactor = new AnchoredContextCompactor({
  tokenThreshold: 40,
  eventRetentionSize: 2,
  summarizer: new LlmSummarizer({
    llm: new GeminiWithMockResponses([
      // First compaction summary response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Compacted summary of turn 1 and 2.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          totalTokenCount: 15,
        },
      },
      // Second compaction summary response (if triggered again)
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Compacted summary including turn 3 and 4.'}],
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
  name: 'anchored_compaction_agent',
  model: 'gemini-2.5-flash',
  description: 'Agent to demonstrate anchored context compaction.',
  instruction: 'You are a helpful assistant that answers concisely.',
  contextCompactors: [compactor],
});
