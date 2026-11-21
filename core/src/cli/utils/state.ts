/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from '../../agents/base_agent.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {BaseNode} from '../../workflow/base_node.js';
import {isParallelWorker} from '../../workflow/nodes/parallel_worker.js';
import {isWorkflow} from '../../workflow/workflow.js';

function populateEmptyState(
  node: BaseNode,
  allState: Record<string, unknown>,
  visited: Set<BaseNode>,
): void {
  if (visited.has(node)) {
    return;
  }
  visited.add(node);

  if (isBaseAgent(node)) {
    for (const subAgent of node.subAgents) {
      populateEmptyState(subAgent, allState, visited);
    }
  }

  if (isWorkflow(node) && node.graph) {
    for (const graphNode of node.graph.nodes) {
      populateEmptyState(graphNode, allState, visited);
    }
  }

  if (isParallelWorker(node)) {
    populateEmptyState(node.inner, allState, visited);
  }

  if (
    isLlmAgent(node) &&
    node.instruction &&
    typeof node.instruction === 'string'
  ) {
    const matches = node.instruction.matchAll(/\{([\w]+)\}/g);
    for (const match of matches) {
      const key = match[1];
      if (key !== '__proto__') {
        allState[key] = '';
      }
    }
  }
}

/**
 * Creates a state object initialized with empty strings `''` for all `{var}`
 * placeholders referenced in static instruction strings across `agent`, its
 * sub-agents, workflow graph nodes, and parallel workers, overridden by any
 * keys provided in `initializedStates`.
 *
 * @param agent The root agent or workflow node to inspect.
 * @param initializedStates Optional pre-initialized state values that take precedence.
 * @returns The combined state record.
 */
export function createEmptyState(
  agent: BaseAgent | BaseNode,
  initializedStates?: Record<string, unknown>,
): Record<string, unknown> {
  const allState: Record<string, unknown> = {};
  populateEmptyState(agent, allState, new Set());
  if (initializedStates) {
    for (const [key, value] of Object.entries(initializedStates)) {
      if (key !== '__proto__') {
        allState[key] = value;
      }
    }
  }
  return allState;
}
