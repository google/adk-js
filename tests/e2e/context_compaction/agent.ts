/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentControlledContextCompactor,
  ConsolidateContextTool,
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

export function createAgentControlledCompactionAgent(): LlmAgent {
  const compactor = new AgentControlledContextCompactor({
    summarizer: new LlmSummarizer({
      llm: new Gemini({model: 'gemini-2.5-flash'}),
    }),
  });

  return new LlmAgent({
    name: 'agent_controlled_compaction_agent',
    description:
      'An agent configured to test live agent-controlled context compaction.',
    instruction:
      'You are a helpful conversational AI. If the user asks you to consolidate context or wrap up ' +
      'what you have done so far, you MUST call the consolidate_context tool. ' +
      'Always respond concisely.',
    model: 'gemini-2.5-flash',
    tools: [new ConsolidateContextTool()],
    contextCompactors: [compactor],
  });
}
