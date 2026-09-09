/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, AgentInterface, AgentSkill} from '@a2a-js/sdk';
import {DefaultAgentCardResolver} from '@a2a-js/sdk/client';
import * as fs from 'node:fs/promises';
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
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';
import {isWorkflow} from '../workflow/workflow.js';

/**
 * Options controlling how a fetched agent card's RPC URL(s) are validated
 * against the location the card was fetched from. See {@link
 * validateCardRpcTargets} for what each check defends against and why
 * both default to failing closed.
 */
export interface ResolveAgentCardOptions {
  /**
   * Explicit escape hatch to accept a plaintext http:// RPC URL on a
   * non-loopback host.
   *
   * This is intentionally insecure: an RPC URL that isn't https and isn't
   * on this machine can be intercepted or altered by anything on the
   * network path, even when its origin matches the card's own. Only set
   * this for a card source you know serves plain http on a host you
   * trust (e.g. a private, internal service reached over a channel
   * that's secured some other way). When set to `true`, a loud warning is
   * logged for each RPC URL this affects.
   *
   * Defaults to `false`: RPC URLs must be https, or http on a loopback
   * host (localhost, 127.0.0.0/8, ::1, 0.0.0.0, or ::).
   */
  allowInsecureRpc?: boolean;
  /**
   * Explicit escape hatch to accept an RPC URL whose origin differs from
   * the location the card was fetched from.
   *
   * This is intentionally permissive: it is what lets a compromised or
   * misconfigured card-hosting endpoint redirect all subsequent A2A
   * traffic for this agent, including whatever credential material the
   * request-forwarding path carries, to a different origin than the one
   * that was actually configured and fetched. The A2A spec allows a card
   * to point RPC at a different origin than where the card itself is
   * served from (e.g. static card hosting separate from the API
   * backend), which is the legitimate case this exists for -- only set
   * this when that's a shape you actually expect. When set to `true`, a
   * loud warning is logged for each RPC URL this affects.
   *
   * Defaults to `false`: every RPC URL must share the origin the card
   * was fetched from.
   */
  allowCrossOriginRpc?: boolean;
}

/**
 * Resolves the AgentCard from the provided source.
 */
export async function resolveAgentCard(
  agentCard: AgentCard | string,
  options: ResolveAgentCardOptions = {},
): Promise<AgentCard> {
  if (typeof agentCard === 'object') {
    return agentCard;
  }

  const source = agentCard as string;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const resolver = new DefaultAgentCardResolver();
    const card = await resolver.resolve(source);
    validateCardRpcTargets(card, source, options);
    return card;
  }

  try {
    const content = await fs.readFile(source, 'utf-8');
    return JSON.parse(content) as AgentCard;
  } catch (err: unknown) {
    throw new Error(
      `Failed to read agent card from file ${source}: ${(err as Error).message}`,
    );
  }
}

/**
 * Constrains where a card fetched over the network may aim RPC traffic.
 *
 * A card served from a trusted, configured source URL is not itself
 * trusted content: the response is JSON from whatever answered that
 * request, which could be a compromised or misconfigured server, a MITM
 * on the fetch, or a domain that has since changed hands. Without this
 * check, that response's declared RPC url(s) are followed with no
 * verification at all -- every subsequent A2A request for this agent,
 * including whatever credential material the request-forwarding path
 * carries, would go to wherever the card says, not wherever it was
 * actually fetched from.
 *
 * Every URL the card offers is checked (the primary `url` and each of
 * `additionalInterfaces`), not only whichever one a given transport
 * negotiation would select, since any of them could end up being used.
 * This applies two independent checks, each with its own escape hatch
 * (see {@link ResolveAgentCardOptions}), since they defend against
 * different things and a legitimate deployment may need to relax one
 * without the other:
 *
 * - https, or http on a loopback host: defends against network-path
 *   interception of the RPC connection itself, independent of whether
 *   its origin matches the card's.
 * - same origin as the card's source: defends against the card
 *   redirecting RPC traffic to a different origin than the one actually
 *   configured and fetched.
 *
 * Only applies when the card was fetched over http(s); a card provided
 * directly as an object, or read from a local file, did not come off the
 * network here, and its target is left to the caller.
 */
function validateCardRpcTargets(
  card: AgentCard,
  source: string,
  options: ResolveAgentCardOptions,
): void {
  let parsedSource: URL;
  try {
    parsedSource = new URL(source);
  } catch (err: unknown) {
    throw new Error(
      `Invalid agent card source URL: ${source}: ${(err as Error).message}`,
    );
  }

  const rpcUrls: string[] = [
    card.url,
    ...(card.additionalInterfaces ?? []).map((i: AgentInterface) => i.url),
  ];

  for (const rpcUrl of rpcUrls) {
    let parsed: URL;
    try {
      parsed = new URL(rpcUrl);
    } catch (err: unknown) {
      throw new Error(
        `Invalid RPC URL in agent card: ${rpcUrl}: ${(err as Error).message}`,
      );
    }

    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      if (options.allowInsecureRpc === true) {
        logger.warn(
          'SECURITY WARNING: accepting a plaintext http RPC URL on a ' +
            `non-loopback host because \`allowInsecureRpc: true\` was set: ` +
            `${rpcUrl}. This connection can be intercepted or altered by ` +
            'anything on the network path.',
        );
      } else {
        throw new Error(
          `Agent card RPC URL must use https, or http on a loopback host: ${rpcUrl}`,
        );
      }
    }

    if (!sameOriginForRpc(parsedSource, parsed)) {
      if (options.allowCrossOriginRpc === true) {
        logger.warn(
          'SECURITY WARNING: accepting an agent card RPC URL whose origin ' +
            'differs from the location the card was fetched from because ' +
            `\`allowCrossOriginRpc: true\` was set (fetched from ${source}): ` +
            `${rpcUrl}.`,
        );
      } else {
        throw new Error(
          'Agent card RPC URL must have the same origin as the location the ' +
            `card was fetched from (${source}): ${rpcUrl}`,
        );
      }
    }
  }
}

/**
 * Whether `source` and `rpc` should be treated as the same origin for RPC
 * targeting purposes.
 *
 * A plain origin comparison (`source.origin === rpc.origin`) treats
 * different loopback hostnames as different origins, even though they
 * all name this same machine: `localhost`, `127.0.0.1`, `0.0.0.0`, and
 * `::` are all in practical use as the bind/connect address a local
 * server ends up reachable on (adk-js's own `toA2a` defaults its `host`
 * to `localhost`; `adk deploy` passes `--host=0.0.0.0`, and a request to
 * `0.0.0.0:<port>` does reach that listener). When both sides are
 * loopback, they're compared on scheme and port only; otherwise, the
 * full origin must match.
 */
function sameOriginForRpc(source: URL, rpc: URL): boolean {
  const sourceIsLoopback = isLoopbackHost(source.hostname);
  const rpcIsLoopback = isLoopbackHost(rpc.hostname);
  if (sourceIsLoopback && rpcIsLoopback) {
    return (
      source.protocol === rpc.protocol &&
      effectivePort(source) === effectivePort(rpc)
    );
  }
  return source.origin === rpc.origin;
}

/**
 * Returns `url.port`, or the scheme's default port when `url.port` is
 * empty (an omitted default port, e.g. `http://host/x`, and an explicit
 * one, e.g. `http://host:80/x`, both leave `URL.port` and `''` and `'80'`
 * respectively -- comparing those directly would treat the same
 * effective port as a mismatch).
 */
function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === 'https:') {
    return '443';
  }
  if (url.protocol === 'http:') {
    return '80';
  }
  return url.port;
}

/** Whether `hostname` names this machine itself (loopback), not a remote host. */
function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    bare === 'localhost' ||
    bare === '127.0.0.1' ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    bare === '::' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
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
