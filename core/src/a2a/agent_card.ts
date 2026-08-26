/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, AgentInterface, AgentSkill} from '@a2a-js/sdk';
import {DefaultAgentCardResolver} from '@a2a-js/sdk/client';
import * as fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BaseAgent} from '../agents/base_agent.js';

import {
  InvocationContext,
  InvocationContextParams,
} from '../agents/invocation_context.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {isLoopAgent, LoopAgent} from '../agents/loop_agent.js';
import {isParallelAgent} from '../agents/parallel_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {isSequentialAgent} from '../agents/sequential_agent.js';
import {BaseTool, isBaseTool} from '../tools/base_tool.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';
import {
  isHttpUrl,
  isLinkLocalAddress,
  normalizeHost,
  resolveHostAddresses,
} from '../utils/ssrf_guard.js';
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {isWorkflow} from '../workflow/workflow.js';

/**
 * A single-letter URL protocol, which is a Windows drive letter rather than a
 * scheme: `new URL('C:\\cards\\card.json')` parses with `protocol === 'c:'`.
 */
const WINDOWS_DRIVE_PROTOCOL = /^[a-z]:$/i;

/**
 * Resolves the AgentCard from the provided source.
 *
 * A source is either an {@link AgentCard}, an `http(s)://` URL to fetch it
 * from, a `file://` URL, or a filesystem path. Any other URL scheme throws: a
 * source that looks like a URL is never read off the local filesystem.
 *
 * The card host must not be, or resolve to, a link-local address, and a
 * redirect from the card endpoint is refused rather than followed. Loopback and
 * private addresses stay allowed: they are where a locally served or
 * VPC-internal peer agent lives.
 */
export async function resolveAgentCard(
  agentCard: AgentCard | string,
): Promise<AgentCard> {
  if (typeof agentCard === 'object') {
    return agentCard;
  }

  const url = parseCardUrl(agentCard);
  if (url && isHttpUrl(url)) {
    const resolver = new DefaultAgentCardResolver({
      fetchImpl: guardedAgentCardFetch,
    });
    return resolver.resolve(agentCard);
  }
  if (url && url.protocol !== 'file:') {
    throw new Error(
      `Unsupported agent card URL scheme "${url.protocol}": ${agentCard}. ` +
        'Use http://, https:// or file://, or pass a filesystem path with no scheme.',
    );
  }
  return readAgentCardFile(agentCard, url);
}

/**
 * Parses an absolute URL out of a card source, or returns `null` when the
 * source names a filesystem path.
 */
function parseCardUrl(source: string): URL | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  return WINDOWS_DRIVE_PROTOCOL.test(url.protocol) ? null : url;
}

/** Reads and parses a card from `url` when it is a `file:` URL, else from `source`. */
async function readAgentCardFile(
  source: string,
  url: URL | null,
): Promise<AgentCard> {
  try {
    const path = url ? fileURLToPath(url) : source;
    const content = await fs.readFile(path, 'utf-8');
    return JSON.parse(content) as AgentCard;
  } catch (err: unknown) {
    throw new Error(
      `Failed to read agent card from file ${source}: ${(err as Error).message}`,
    );
  }
}

/**
 * Fetches the agent card, refusing a link-local host and any redirect.
 *
 * The guard lives here rather than before {@link DefaultAgentCardResolver} runs
 * because this is the single point where the resolver reaches the network, and
 * the only place a URL the developer did not write can appear.
 */
const guardedAgentCardFetch: typeof fetch = async (input, init) => {
  // `Request` normalizes every form `fetch` accepts: a string, a URL, a Request.
  const url = new URL(new Request(input).url);
  await assertHostAllowed(url);
  const response = await fetch(url, {...init, redirect: 'manual'});
  if (isRedirect(response.status)) {
    throw new Error(
      `Refusing to follow a redirect while fetching the agent card from ${url} ` +
        `(status ${response.status}, location ${response.headers.get('location')}). ` +
        'Configure the final URL instead.',
    );
  }
  return response;
};

/**
 * Returns `true` for a redirect response, including the opaque one a `manual`
 * redirect produces on platforms that hide the status.
 */
function isRedirect(status: number): boolean {
  return status === 0 || (status >= 300 && status < 400);
}

/** Throws when the URL's host is, or resolves to, a link-local address. */
async function assertHostAllowed(url: URL): Promise<void> {
  const host = normalizeHost(url.hostname);
  const addresses = await resolveHostAddresses(host);
  if (addresses.some(isLinkLocalAddress)) {
    throw new Error(
      `Refusing to fetch agent card from a link-local address: ${host}`,
    );
  }
}

/**
 * Converts an ADK agent to an A2A AgentCard.
 */
export async function getA2AAgentCard(
  agent: RunnableRoot,
  transports: AgentInterface[],
): Promise<AgentCard> {
  return {
    name: agent.name,
    description: agent.description || '',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    skills: await buildAgentSkills(agent),
    url: transports[0].url,
    preferredTransport: transports[0].transport,
    capabilities: {
      extensions: [],
      stateTransitionHistory: false,
      pushNotifications: false,
      streaming: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    additionalInterfaces: transports,
  };
}

/**
 * Builds a list of AgentSkills based on agent descriptions and types.
 * This information can be used in AgentCard to help clients understand agent capabilities.
 *
 * @param agent The agent to build skills for.
 * @returns A promise resolving to a list of AgentSkills.
 */
export async function buildAgentSkills(
  agent: RunnableRoot,
): Promise<AgentSkill[]> {
  const [primarySkills, subAgentSkills] = await Promise.all([
    buildPrimarySkills(agent),
    buildSubAgentSkills(agent),
  ]);

  return [...primarySkills, ...subAgentSkills];
}

async function buildPrimarySkills(agent: RunnableRoot): Promise<AgentSkill[]> {
  if (isWorkflow(agent)) {
    // A workflow advertises itself as one skill. It has no sub-agents to
    // enumerate, and its internals are a graph rather than a roster.
    return [
      {
        id: agent.name,
        name: 'workflow',
        description: agent.description || `Workflow ${agent.name}`,
        tags: ['workflow'],
      },
    ];
  }
  if (isLlmAgent(agent)) {
    return buildLLMAgentSkills(agent);
  }

  return buildNonLLMAgentSkills(agent);
}

async function buildSubAgentSkills(agent: RunnableRoot): Promise<AgentSkill[]> {
  // A workflow has nodes, not sub-agents: its shape is described by the single
  // `workflow` skill rather than one skill per child.
  const subAgents = isWorkflow(agent) ? [] : agent.subAgents;
  const result: AgentSkill[] = [];

  for (const sub of subAgents) {
    const skills = await buildPrimarySkills(sub);
    for (const subSkill of skills) {
      const skill: AgentSkill = {
        id: `${sub.name}_${subSkill.id}`,
        name: `${sub.name}: ${subSkill.name}`,
        description: subSkill.description,
        tags: [`sub_agent:${sub.name}`, ...subSkill.tags],
      };
      result.push(skill);
    }
  }

  return result;
}

async function buildLLMAgentSkills(agent: LlmAgent): Promise<AgentSkill[]> {
  const skills: AgentSkill[] = [
    {
      id: agent.name,
      name: 'model',
      description: await buildDescriptionFromInstructions(agent),
      tags: ['llm'],
    },
  ];

  if (agent.tools && agent.tools.length > 0) {
    for (const toolUnion of agent.tools) {
      if (isBaseTool(toolUnion)) {
        skills.push(toolToSkill(agent.name, toolUnion));
      } else if (isBaseToolset(toolUnion)) {
        const tools = await toolUnion.getTools();

        for (const tool of tools) {
          skills.push(toolToSkill(agent.name, tool));
        }
      }
    }
  }

  return skills;
}

function toolToSkill(prefix: string, tool: BaseTool): AgentSkill {
  let description = tool.description;
  if (!description) {
    description = `Tool: ${tool.name}`;
  }

  return {
    id: `${prefix}-${tool.name}`,
    name: tool.name,
    description: description,
    tags: ['llm', 'tools'],
  };
}

function buildNonLLMAgentSkills(agent: BaseAgent): AgentSkill[] {
  const skills: AgentSkill[] = [
    {
      id: agent.name,
      name: getAgentSkillName(agent),
      description: buildAgentDescription(agent),
      tags: [getAgentTypeTag(agent)],
    },
  ];

  const subAgents = agent.subAgents;
  if (subAgents.length > 0) {
    const descriptions = subAgents.map(
      (sub) => sub.description || 'No description',
    );
    skills.push({
      id: `${agent.name}-sub-agents`,
      name: 'sub-agents',
      description: `Orchestrates: ${descriptions.join('; ')}`,
      tags: [getAgentTypeTag(agent), 'orchestration'],
    });
  }

  return skills;
}

function buildAgentDescription(agent: BaseAgent): string {
  const descriptionParts: string[] = [];

  if (agent.description) {
    descriptionParts.push(agent.description);
  }

  if (agent.subAgents.length > 0) {
    if (isLoopAgent(agent)) {
      descriptionParts.push(buildLoopAgentDescription(agent));
    } else if (isParallelAgent(agent)) {
      descriptionParts.push(buildParallelAgentDescription(agent));
    } else if (isSequentialAgent(agent)) {
      descriptionParts.push(buildSequentialAgentDescription(agent));
    }
  }

  if (descriptionParts.length > 0) {
    return descriptionParts.join(' ');
  } else {
    return getDefaultAgentDescription(agent);
  }
}

function buildSequentialAgentDescription(agent: BaseAgent): string {
  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`First, this agent will ${subDescription}.`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`Finally, this agent will ${subDescription}.`);
    } else {
      descriptions.push(`Then, this agent will ${subDescription}.`);
    }
  });

  return descriptions.join(' ');
}

function buildParallelAgentDescription(agent: BaseAgent): string {
  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`This agent will ${subDescription}`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`and ${subDescription}`);
    } else {
      descriptions.push(`, ${subDescription}`);
    }
  });

  return `${descriptions.join(' ')} simultaneously.`;
}

function buildLoopAgentDescription(agent: LoopAgent): string {
  const maxIterationsVal = agent.maxIterations;
  let maxIterations = 'unlimited';
  if (
    typeof maxIterationsVal === 'number' &&
    maxIterationsVal < Number.MAX_SAFE_INTEGER
  ) {
    maxIterations = maxIterationsVal.toString();
  }

  const subAgents = agent.subAgents;
  const descriptions: string[] = [];

  subAgents.forEach((sub, i) => {
    let subDescription = sub.description;
    if (!subDescription) {
      subDescription = `execute the ${sub.name} agent`;
    }

    if (i === 0) {
      descriptions.push(`This agent will ${subDescription}`);
    } else if (i === subAgents.length - 1) {
      descriptions.push(`and ${subDescription}`);
    } else {
      descriptions.push(`, ${subDescription}`);
    }
  });

  return `${descriptions.join(' ')} in a loop (max ${maxIterations} iterations).`;
}

async function buildDescriptionFromInstructions(
  agent: LlmAgent,
): Promise<string> {
  const descriptionParts: string[] = [];
  if (agent.description) {
    descriptionParts.push(agent.description);
  }

  if (agent.instruction) {
    let instructionStr: string;
    if (typeof agent.instruction === 'function') {
      const dummyContext = new ReadonlyContext(
        new InvocationContext({
          agent: agent,
        } as unknown as InvocationContextParams),
      );
      try {
        instructionStr = await agent.instruction(dummyContext);
      } catch (e) {
        logger.warn('Failed to resolve dynamic instruction for AgentCard', e);
        instructionStr = '';
      }
    } else {
      instructionStr = agent.instruction;
    }

    if (instructionStr) {
      descriptionParts.push(replacePronouns(instructionStr));
    }
  }

  const root = agent.rootAgent;
  if (isLlmAgent(root) && root.globalInstruction) {
    let globalInstructionStr: string;
    if (typeof root.globalInstruction === 'function') {
      const dummyContext = new ReadonlyContext(
        new InvocationContext({
          agent: agent,
        } as unknown as InvocationContextParams),
      );
      try {
        globalInstructionStr = await root.globalInstruction(dummyContext);
      } catch (e) {
        logger.warn(
          'Failed to resolve dynamic global instruction for AgentCard',
          e,
        );
        globalInstructionStr = '';
      }
    } else {
      globalInstructionStr = root.globalInstruction;
    }

    if (globalInstructionStr) {
      descriptionParts.push(replacePronouns(globalInstructionStr));
    }
  }

  if (descriptionParts.length > 0) {
    return descriptionParts.join(' ');
  } else {
    return getDefaultAgentDescription(agent);
  }
}

// Replaces pronouns and conjugate common verbs for agent description.
// Examples: "You are" -> "I am", "your" -> "my"
function replacePronouns(instruction: string): string {
  const substitutions = [
    {original: 'you were', target: 'I was'},
    {original: 'you are', target: 'I am'},
    {original: "you're", target: 'I am'},
    {original: "you've", target: 'I have'},
    {original: 'yours', target: 'mine'},
    {original: 'your', target: 'my'},
    {original: 'you', target: 'I'},
  ];

  let result = instruction;
  for (const sub of substitutions) {
    // Only replace whole words, case insensitive
    const pattern = new RegExp(`\\b${sub.original}\\b`, 'gi');
    result = result.replace(pattern, sub.target);
  }
  return result;
}

function getDefaultAgentDescription(agent: BaseAgent): string {
  if (isLoopAgent(agent)) {
    return 'A loop workflow agent';
  } else if (isSequentialAgent(agent)) {
    return 'A sequential workflow agent';
  } else if (isParallelAgent(agent)) {
    return 'A parallel workflow agent';
  } else if (isLlmAgent(agent)) {
    return 'An LLM-based agent';
  } else {
    return 'A custom agent';
  }
}

function getAgentTypeTag(agent: BaseAgent): string {
  if (isLoopAgent(agent)) {
    return 'loop_workflow';
  } else if (isSequentialAgent(agent)) {
    return 'sequential_workflow';
  } else if (isParallelAgent(agent)) {
    return 'parallel_workflow';
  } else if (isLlmAgent(agent)) {
    return 'llm_agent';
  } else {
    return 'custom_agent';
  }
}

function getAgentSkillName(agent: BaseAgent): string {
  if (isLlmAgent(agent)) {
    return 'model';
  }
  if (isCompositeShellAgent(agent) || isWorkflow(agent)) {
    return 'workflow';
  }
  return 'custom';
}

function isCompositeShellAgent(agent: BaseAgent): boolean {
  return (
    isLoopAgent(agent) || isSequentialAgent(agent) || isParallelAgent(agent)
  );
}
