/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {AgentTool, LlmAgent} from '@google/adk';

const summaryAgent = new LlmAgent({
  model: 'gemini-2.0-flash',
  name: 'summary_agent',
  instruction:
    'You are an expert summarizer. Please read the following text and provide a concise summary.',
  description: 'Agent to summarize text',
});

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-2.5-flash',
  instruction:
    "You are a helpful assistant. When the user provides a text, use the 'summarize' tool to generate a summary. Always forward the user's message exactly as received to the 'summarize' tool, without modifying or summarizing it yourself. Present the response from the tool to the user.",
  tools: [new AgentTool({agent: summaryAgent, skipSummarization: true})],
});
