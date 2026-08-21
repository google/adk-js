/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {REQUEST_INPUT_FUNCTION_CALL_NAME} from '../agents/functions.js';
import {LongRunningFunctionTool} from './long_running_tool.js';

/**
 * A long-running tool that presents a custom message to the user and awaits
 * unstructured or structured input.
 *
 * `response_schema` is spelled the way a workflow's `RequestInput` spells it on
 * the wire (`RESPONSE_SCHEMA_ARG` in `workflow/utils/hitl_utils`), so a client
 * reads one key whichever way the pause was raised — the dev UI builds its
 * reply form from it either way.
 */
export const requestInputTool = new LongRunningFunctionTool({
  name: REQUEST_INPUT_FUNCTION_CALL_NAME,
  description:
    'Presents a custom message to the user and awaits unstructured or structured input.',
  parameters: z.object({
    message: z.string().describe('The prompt for the user.'),
    response_schema: z
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
