/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentTool, LlmAgent, Workflow} from '@google/adk';

import {
  BASE_INSTRUCTION,
  FINAL_TEXT,
  FIRST_TURN_USAGE,
  makePartResponse,
  NESTED_TURN_USAGE,
  NODE_RESULT,
  ScriptedModel,
  type ScriptedTurn,
  SECOND_TURN_USAGE,
  USER_PROMPT,
} from '../telemetry_test_utils.js';

export const AGENT_TOOL_WORKFLOW_NAME = 'my_agent_tool_workflow';
export const DELEGATING_AGENT_NAME = 'some_delegating_agent';
export const DELEGATING_AGENT_DESCRIPTION = 'A sample agent that delegates.';
export const DELEGATE_AGENT_NAME = 'some_delegate_agent';
export const DELEGATE_AGENT_DESCRIPTION = 'A sample delegate agent.';

/**
 * Builds the `my_agent_tool_workflow` graph with an agent calling `AgentTool`.
 */
export function createAgentToolWorkflow(): Workflow {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {
        functionCall: {
          name: DELEGATE_AGENT_NAME,
          args: {request: USER_PROMPT},
        },
      },
      usageMetadata: FIRST_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: NODE_RESULT},
      usageMetadata: NESTED_TURN_USAGE,
    }),
    makePartResponse({
      part: {text: FINAL_TEXT},
      usageMetadata: SECOND_TURN_USAGE,
    }),
  ];
  const model = new ScriptedModel(turns);
  const delegate = new LlmAgent({
    name: DELEGATE_AGENT_NAME,
    description: DELEGATE_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const delegatingAgent = new LlmAgent({
    name: DELEGATING_AGENT_NAME,
    description: DELEGATING_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
    tools: [new AgentTool({agent: delegate})],
  });
  return new Workflow({
    name: AGENT_TOOL_WORKFLOW_NAME,
    edges: [['START', delegatingAgent]],
  });
}
