/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, LlmAgent} from '@google/adk';
import {ThinkingLevel} from '@google/genai';
import {z} from 'zod';

const currentTimeTool = new FunctionTool({
  name: 'get_current_time',
  description: 'Get the current date and time',
  parameters: z.object({}),
  execute: () => '2026-04-10T21:13:34.609Z',
});

export const rootAgent = new LlmAgent({
  name: 'streaming_repro_agent',
  model: 'gemini-3-flash-preview',
  generateContentConfig: {
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.HIGH,
      includeThoughts: true,
    },
  },
  instruction: 'You MUST use the get_current_time tool to answer.',
  tools: [currentTimeTool],
});
