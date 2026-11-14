/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Tool} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';

/**
 * Details about an individual agent in the app.
 *
 * This could be the root agent or any of the sub-agents in the agent tree.
 */
export interface AgentDetails {
  /** The name of the agent that uniquely identifies it in the app. */
  name: string;

  /** The instructions set on the agent. */
  instructions: string;

  /** The tools available to the agent. */
  toolDeclarations: Tool[];
}

/**
 * Details about the app (the agentic system).
 *
 * This structure is only a projection of the actual app. Only details that are
 * relevant to the evaluation system are captured here.
 */
export interface AppDetails {
  /** A mapping from the agent name to the details of that agent. */
  agentDetails: Record<string, AgentDetails>;
}

/**
 * Returns the developer instructions of the named agent.
 *
 * @param appDetails The app to look the agent up in.
 * @param agentName The name of the agent.
 * @returns The instructions set on the agent.
 * @throws If the agent is not part of the app.
 */
export function getDeveloperInstructionsByAgentName(
  appDetails: AppDetails,
  agentName: string,
): string {
  const details = appDetails.agentDetails[agentName];
  if (!details) {
    throw new Error(`\`${agentName}\` not found in the agentic system.`);
  }
  return details.instructions;
}

/**
 * Returns the tools available to each agent in the app, keyed by agent name.
 *
 * @param appDetails The app to read the tools from.
 * @returns A record from agent name to that agent's tool declarations.
 */
export function getToolsByAgentName(
  appDetails: AppDetails,
): Record<string, Tool[]> {
  return Object.fromEntries(
    Object.entries(appDetails.agentDetails).map(([name, details]) => [
      name,
      details.toolDeclarations,
    ]),
  );
}

/**
 * Builds {@link AppDetails} from an agent tree.
 *
 * Every agent in the tree gets an entry. For an `LlmAgent`, the entry carries
 * its instruction when that instruction is a static string, and the function
 * declarations of its tools. Instruction providers are not resolved, because
 * they need a live invocation context.
 *
 * @param rootAgent The root of the agent tree.
 * @returns The details of every agent in the tree, keyed by agent name.
 */
export async function buildAppDetailsFromAgent(
  rootAgent: BaseAgent,
): Promise<AppDetails> {
  const agentDetails: Record<string, AgentDetails> = {};
  const pending: BaseAgent[] = [rootAgent];
  for (let agent = pending.shift(); agent; agent = pending.shift()) {
    pending.push(...agent.subAgents);
    if (agent.name in agentDetails) {
      continue;
    }
    agentDetails[agent.name] = isLlmAgent(agent)
      ? await buildLlmAgentDetails(agent)
      : {name: agent.name, instructions: '', toolDeclarations: []};
  }
  return {agentDetails};
}

async function buildLlmAgentDetails(agent: LlmAgent): Promise<AgentDetails> {
  const functionDeclarations = (await agent.canonicalTools())
    .map((tool) => tool._getDeclaration())
    .filter(
      (declaration): declaration is FunctionDeclaration =>
        declaration !== undefined,
    );
  return {
    name: agent.name,
    instructions:
      typeof agent.instruction === 'string' ? agent.instruction : '',
    toolDeclarations:
      functionDeclarations.length > 0 ? [{functionDeclarations}] : [],
  };
}
