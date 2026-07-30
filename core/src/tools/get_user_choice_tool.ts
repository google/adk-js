/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {LongRunningFunctionTool} from './long_running_tool.js';

/**
 * A long-running tool that presents a list of options to the user and awaits
 * their selection.
 */
export const getUserChoiceTool = new LongRunningFunctionTool({
  name: 'get_user_choice',
  description:
    'Presents a list of options to the user and awaits their selection.',
  parameters: z.object({
    options: z
      .array(z.string())
      .describe('List of options to present to the user.'),
  }),
  execute: async (input, context) => {
    if (context) {
      context.actions.skipSummarization = true;
    }
    return null;
  },
});
