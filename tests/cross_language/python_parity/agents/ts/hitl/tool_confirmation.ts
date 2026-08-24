/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/hitl/tool_confirmation.
 *
 * Both gates the sample contrasts exist in adk-js with the same shape:
 *   - dynamic: `tool_context.request_confirmation(hint=...)` from inside the
 *     tool becomes `toolContext.requestConfirmation({hint})`, and the tool is
 *     re-invoked with `toolContext.toolConfirmation` set.
 *   - static: `FunctionTool(func=close_account, require_confirmation=True)`
 *     becomes `requireConfirmation: true`, and the body only runs on approval.
 *
 * The Python sample sets no instruction and no model, so neither is set here
 * beyond the pinned parity model (which the Python shim also pins).
 */
import {Context, FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const transferFunds = new FunctionTool({
  name: 'transfer_funds',
  description: 'Transfers funds to a recipient.',
  parameters: z.object({
    amount: z.number(),
    recipient: z.string(),
  }),
  execute: ({amount, recipient}, toolContext?: Context) => {
    // Only request confirmation for amounts >= 100
    if (amount >= 100) {
      if (!toolContext?.toolConfirmation) {
        toolContext?.requestConfirmation({
          hint: `Confirm transfer of $${amount} to ${recipient}.`,
        });
        return {
          error:
            'This tool call requires confirmation, please approve or reject.',
        };
      } else if (!toolContext.toolConfirmation.confirmed) {
        return {error: 'Transfer rejected by user.'};
      }
    }

    // Proceed with transfer for amounts < 100 or if confirmed
    return {result: `Successfully transferred $${amount} to ${recipient}.`};
  },
});

const closeAccount = new FunctionTool({
  name: 'close_account',
  description: 'Closes a user account. This is a destructive action.',
  parameters: z.object({
    account_id: z.string(),
  }),
  // With requireConfirmation=true, this function is only called if the user
  // approves.
  execute: ({account_id}) => ({
    result: `Account ${account_id} closed successfully.`,
  }),
  requireConfirmation: true,
});

export const rootAgent = new LlmAgent({
  name: 'money_transfer_assistant',
  model: PARITY_MODEL,
  tools: [transferFunds, closeAccount],
});
