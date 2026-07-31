/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {LongRunningFunctionTool} from './long_running_tool.js';

/**
 * A long-running tool that presents a custom message to the user and awaits
 * unstructured or structured input.
 */
export const requestInputTool = new LongRunningFunctionTool({
  name: 'adk_request_input',
  description:
    'Presents a custom message to the user and awaits unstructured or structured input.',
  parameters: z.object({
    message: z.string().describe('The prompt for the user.'),
    responseSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Expected schema of the response.'),
  }),
  execute: async (input, context) => {
    if (context) {
      context.actions.skipSummarization = true;
    }
    return null;
  },
});
