/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {node, Workflow} from '@google/adk';

import {
  buildTestAgent,
  buildToolCallingTurns,
  NESTED_WORKFLOW_NAME,
  NODE_RESULT,
  ScriptedModel,
  WORKFLOW_NAME,
} from '../telemetry_test_utils.js';

const someNode = node(async () => NODE_RESULT, {name: 'some_node'});

/**
 * Builds `my_workflow` with `my_nested_workflow` running `some_node`.
 */
export function createNodeWorkflow(): Workflow {
  const model = new ScriptedModel(buildToolCallingTurns());
  const testAgent = buildTestAgent(model);
  const nestedWorkflow = new Workflow({
    name: NESTED_WORKFLOW_NAME,
    edges: [['START', someNode]],
  });
  return new Workflow({
    name: WORKFLOW_NAME,
    edges: [['START', nestedWorkflow, testAgent]],
  });
}
