/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParityCase} from '../harness/types.ts';

export const MULTI_AGENT_CASES: ParityCase[] = [
  {
    // Queries are the user turns from the upstream
    // `tests/roll_die_and_check_prime.json` replay.
    id: 'multi_agent_hello_world_ma',
    family: 'multi_agent',
    pySample: 'multi_agent/hello_world_ma',
    tsAgent: 'multi_agent/hello_world_ma',
    queries: ['hi', 'roll a dice of 10 dies', 'check it'],
  },
  {
    // Sample inputs 1 and 2 from the upstream README; the second one hits the
    // `require_confirmation` tool on `close_agent` after a peer transfer.
    id: 'multi_agent_sub_agents',
    family: 'multi_agent',
    pySample: 'multi_agent/sub_agents',
    tsAgent: 'multi_agent/sub_agents',
    queries: ['Check the status of account ACC-123.', 'Close account ACC-123.'],
  },
  {
    // The four sample inputs from the upstream README, which walk the full
    // root -> writer -> translator -> writer -> root round trip.
    id: 'multi_agent_three_layer_transfer',
    family: 'multi_agent',
    pySample: 'multi_agent/three_layer_transfer',
    tsAgent: 'multi_agent/three_layer_transfer',
    queries: [
      'Hello, who are you?',
      'Can you write a short story about a lost kitten?',
      'Please translate it into Spanish.',
      "Looks great! Let's return to the project coordinator.",
    ],
  },
  {
    // Query from the upstream `tests/gaming_1000_large.json` replay.
    id: 'multi_agent_single_turn_sub_agent',
    family: 'multi_agent',
    pySample: 'multi_agent/single_turn_sub_agent',
    queries: ['I need a phone mostly for gaming. I have about $1000 to spend.'],
    skip: 'unsupported-in-ts',
    note:
      "adk-js has no equivalent of adk-python's `_SingleTurnAgentTool`. " +
      "`LlmAgent` accepts `mode: 'single_turn'`, but only " +
      '`workflow/run_llm_agent_as_node.ts` honours it, and only for an agent ' +
      'used as a `Workflow` node. adk-python wraps every `single_turn`/`task` ' +
      'sub-agent as a tool in `LlmAgent.__init__` and excludes it from the ' +
      'transfer targets in `flows/llm_flows/agent_transfer.py`; adk-js does ' +
      'neither, so `agents/processors/agent_transfer_llm_request_processor.ts` ' +
      'would offer `phone_recommender` as a `transfer_to_agent` target instead ' +
      'of the `phone_recommender(budget, primary_use, preferred_size)` function ' +
      'call the sample is about.',
  },
  {
    // Query from the upstream `tests/3_burgers_and_credit_card.json` replay.
    id: 'multi_agent_task_sub_agent',
    family: 'multi_agent',
    pySample: 'multi_agent/task_sub_agent',
    queries: ['3 burgers, credit card 1234-1234, cvv 123'],
    skip: 'unsupported-in-ts',
    note:
      "adk-js has no equivalent of adk-python's `_TaskAgentTool`. `mode: " +
      "'task'` and `FinishTaskTool` exist in adk-js, but they are reachable " +
      'only through `workflow/run_llm_agent_as_node.ts`; an `LlmAgent` never ' +
      'wraps a task-mode sub-agent as a callable tool, and there is no port of ' +
      "adk-python's isolation scopes (`Event.isolation_scope`, the " +
      '`order_collector@fc-1` branch in the upstream traces), which is how a ' +
      'task sub-agent keeps its own multi-turn conversation with the user. ' +
      '`core/src/workflow/run_llm_agent_as_node.ts` states the gap outright: ' +
      '"`chat` mode (task delegation via `FinishTaskTool`, isolation scopes) ' +
      'is not yet supported".',
  },
];
