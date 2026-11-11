/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent, Workflow} from '@google/adk';

import {
  BASE_INSTRUCTION,
  buildTestAgent,
  buildToolCallingTurns,
  makePartResponse,
  NESTED_TURN_USAGE,
  NESTED_WORKFLOW_NAME,
  NODE_RESULT,
  ScriptedModel,
  type ScriptedTurn,
  WORKFLOW_NAME,
} from '../telemetry_test_utils.js';

export const NESTED_AGENT_NAME = 'some_nested_agent';
export const NESTED_AGENT_DESCRIPTION =
  'A sample agent inside a nested workflow.';

/**
 * Builds `my_workflow` with `my_nested_workflow` running `some_nested_agent`.
 */
export function createNestedAgentsWorkflow(): Workflow {
  const turns: ScriptedTurn[] = [
    makePartResponse({
      part: {text: NODE_RESULT},
      usageMetadata: NESTED_TURN_USAGE,
    }),
    ...buildToolCallingTurns(),
  ];
  const model = new ScriptedModel(turns);
  const nestedAgent = new LlmAgent({
    name: NESTED_AGENT_NAME,
    description: NESTED_AGENT_DESCRIPTION,
    instruction: BASE_INSTRUCTION,
    model,
  });
  const nestedWorkflow = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [['START', nestedAgent]],
  });
  const testAgent = buildTestAgent(model);
  return new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nestedWorkflow, testAgent]],
  });
}
