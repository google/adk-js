/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/multi_agent/sub_agents.
 *
 * A root agent with two tool-bearing sub-agents, one of whose tools requires
 * user confirmation. Neither sub-agent has an instruction upstream, so routing
 * rests entirely on the agent descriptions — they are copied verbatim.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

// Python derives a tool's description from the whole (cleaned) docstring —
// Args and Returns sections included — and does *not* emit per-parameter
// descriptions. Both docstrings are reproduced whole so the model reads the
// same tool declaration on either side.
const getAccountStatus = new FunctionTool({
  name: 'get_account_status',
  description: `Gets the status of a bank account.

Args:
    account_id: The account ID to check.

Returns:
    The status of the account.`,
  parameters: z.object({
    account_id: z.string(),
  }),
  execute: ({account_id}) => `Account ${account_id} is active.`,
});

const closeAccount = new FunctionTool({
  name: 'close_account',
  description: `Closes a bank account. This action requires user confirmation.

Args:
    account_id: The account ID to close.

Returns:
    A confirmation message.`,
  parameters: z.object({
    account_id: z.string(),
  }),
  // Python spells this `FunctionTool(func=..., require_confirmation=True)`.
  requireConfirmation: true,
  execute: ({account_id}) => `Account ${account_id} has been closed.`,
});

const infoAgent = new LlmAgent({
  name: 'info_agent',
  model: PARITY_MODEL,
  description: 'An agent that can check account status.',
  tools: [getAccountStatus],
});

const closeAgent = new LlmAgent({
  name: 'close_agent',
  model: PARITY_MODEL,
  description: 'An agent that can close accounts.',
  tools: [closeAccount],
});

export const rootAgent = new LlmAgent({
  name: 'sub_agents',
  model: PARITY_MODEL,
  description:
    'A root agent that can check accounts and close them by delegating to' +
    ' sub-agents.',
  subAgents: [infoAgent, closeAgent],
});
