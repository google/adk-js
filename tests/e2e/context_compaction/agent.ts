/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  LlmAgent,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';

export function createCompactionAgent(): LlmAgent {
  // We create a TokenBasedContextCompactor with a low tokenThreshold
  // to aggressively trigger compaction during testing.
  const compactor = new TokenBasedContextCompactor({
    tokenThreshold: 200, // Artificially low token limit.
    eventRetentionSize: 2, // Keep the last 2 events uncompacted out of those triggered.
    summarizer: new LlmSummarizer({
      llm: new Gemini({model: 'gemini-2.5-flash'}),
    }),
  });

  return new LlmAgent({
    name: 'compaction_agent',
    description: 'An agent configured to test live context compaction.',
    instruction:
      'You are a helpful conversational AI. Please provide short, single-sentence answers.',
    model: 'gemini-2.5-flash',
    contextCompactors: [compactor],
  });
}
