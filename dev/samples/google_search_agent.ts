/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GoogleSearchTool, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'root_agent',
  description:
      'an agent whose job it is to perform Google search queries and answer questions about the results.',
  instruction:
      'You are an agent whose job is to perform Google search queries and answer questions about the results.',
  tools: [new GoogleSearchTool()],
});