/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCapabilities,
  AgentCard,
  AgentInterface,
  AgentProvider,
  AgentSkill,
  SecurityScheme,
} from '@a2a-js/sdk';
import {DefaultAgentCardResolver} from '@a2a-js/sdk/client';
import * as fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {isLoopAgent, LoopAgent} from '../agents/loop_agent.js';
import {isParallelAgent} from '../agents/parallel_agent.js';
import {isSequentialAgent} from '../agents/sequential_agent.js';
import {isBaseExampleProvider} from '../examples/base_example_provider.js';
import {propagateTraceContext} from '../telemetry/api/instrumentation.js';
import {isBaseTool} from '../tools/base_tool.js';
import {ExampleTool, isExampleTool} from '../tools/example_tool.js';
import {getErrorMessage} from '../utils/error_utils.js';
import {fetchWithTimeout} from '../utils/fetch_utils.js';
import {logger} from '../utils/logger.js';
import {
  isLinkLocalAddress,
  isLocalhostHostname,
  normalizeHost,
  resolveHostAddresses,
} from '../utils/ssrf_guard.js';
import {BaseNode, START} from '../workflow/base_node.js';
import {
  isRunnableRoot,
  RunnableRoot,
} from '../workflow/run_node_as_invocation.js';
import {isWorkflow, Workflow} from '../workflow/workflow.js';

/**
 * Options controlling how a fetched agent card's RPC URL(s) are validated
 * against the location the card was fetched from. See `validateCardRpcTargets`
 * for what each check defends against and why
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
 * Parameters of {@link resolveAgentCard}: the validation options, plus the
 * request timeout of the caller that fetches the card.
 */
export interface ResolveAgentCardParams extends ResolveAgentCardOptions {
  /**
   * Maximum time to wait for the response headers of the card fetch, in
   * milliseconds. Unset means the fetch has no timeout.
   */
  timeoutMs?: number;
}

const AGENT_CARD_RESOLUTION_ERROR_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.agentCardResolutionError',
);

/**
 * Error thrown when an agent card cannot be resolved from a URL or a file.
 */
export class AgentCardResolutionError extends Error {
  readonly [AGENT_CARD_RESOLUTION_ERROR_SIGNATURE_SYMBOL] = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentCardResolutionError';
    Object.setPrototypeOf(this, AgentCardResolutionError.prototype);
  }
}

/**
 * Type guard for {@link AgentCardResolutionError}.
 *
 * @param obj The value to check.
 * @returns True if obj is an {@link AgentCardResolutionError}.
 */
export function isAgentCardResolutionError(
  obj: unknown,
): obj is AgentCardResolutionError {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (AGENT_CARD_RESOLUTION_ERROR_SIGNATURE_SYMBOL in obj ||
      (obj instanceof Error && obj.name === 'AgentCardResolutionError'))
  );
}

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
 *
 * @throws {@link AgentCardResolutionError} when a URL or file source cannot be
 *     resolved. Its `cause` is the original error.
 */
export async function resolveAgentCard(
  agentCard: AgentCard | string,
  options: ResolveAgentCardParams = {},
): Promise<AgentCard> {
  try {
    if (typeof agentCard === 'string') {
      const source = agentCard.trim();
      if (!source) {
        throw new Error('Agent card source string cannot be empty.');
      }
      return await resolveAgentCardSource(source, options);
    }
    validateResolvedAgentCard(agentCard);
    return agentCard;
  } catch (e: unknown) {
    throw new AgentCardResolutionError(getErrorMessage(e), {cause: e});
  }
}

/** Fetches or reads the card that the URL or filesystem path `source` names. */
async function resolveAgentCardSource(
  source: string,
  options: ResolveAgentCardParams,
): Promise<AgentCard> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    await refuseLinkLocalHost(source);
    const resolver = new DefaultAgentCardResolver({
      fetchImpl:
        options.timeoutMs === undefined
          ? tracePropagatingRefuseRedirectFetch
          : propagateTraceContext(
              fetchWithTimeout({
                timeoutMs: options.timeoutMs,
                fetchImpl: refuseRedirectFetch,
              }),
            ),
    });
    const card = await resolver.resolve(source);
    validateResolvedAgentCard(card);
    validateCardRpcTargets(card, source, options);
    return card;
  }
  const url = parseCardUrl(source);
  if (url && url.protocol !== 'file:') {
    throw new Error(
      `Unsupported agent card URL scheme "${url.protocol}": ${source}. ` +
        'Use http://, https:// or file://, or pass a filesystem path with no scheme.',
    );
  }
  const card = await readAgentCardFile(source, url);
  validateResolvedAgentCard(card);
  return card;
}

/**
 * Checks that a resolved card is a plain object whose `url` parses with a
 * scheme and a host.
 */
function validateResolvedAgentCard(card: unknown): asserts card is AgentCard {
  if (
    typeof card !== 'object' ||
    card === null ||
    Array.isArray(card) ||
    Object.prototype.toString.call(card) !== '[object Object]'
  ) {
    throw new Error('Agent card must be a non-null object.');
  }
  if (!('url' in card) || typeof card.url !== 'string' || !card.url.trim()) {
    throw new Error(
      'Invalid RPC URL in agent card: Agent card must have a valid URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(card.url);
  } catch (err: unknown) {
    throw new Error(
      `Invalid RPC URL in agent card: ${card.url}: ${getErrorMessage(err)}`,
      {cause: err},
    );
  }
  if (!parsed.protocol || !parsed.host) {
    throw new Error(`Invalid RPC URL in agent card: ${card.url}`);
  }
}

/**
 * Matches the single-letter "protocol" Node's URL parser produces for a
 * Windows drive-letter path (e.g. `C:\foo` or `C:/foo` parses with
 * `protocol === 'c:'`), so such a path is treated as a filesystem path
 * rather than rejected as an unsupported URL scheme.
 */
const WINDOWS_DRIVE_PROTOCOL = /^[a-z]:$/i;

/**
 * Rejects `source` if its host is, or resolves to, a link-local address --
 * before any fetch happens, so the request itself never reaches the
 * metadata endpoint a link-local address can expose.
 *
 * Checks every address a hostname resolves to, not only the first: DNS can
 * return several, and `fetch`'s own connection may pick any of them, so one
 * link-local address among otherwise-global ones is still refused.
 */
async function refuseLinkLocalHost(source: string): Promise<void> {
  const hostname = normalizeHost(new URL(source).hostname);
  if (isLocalhostHostname(hostname)) {
    return;
  }
  const addresses = await resolveHostAddresses(hostname);
  if (addresses.some((address) => isLinkLocalAddress(address))) {
    throw new Error(
      `Refusing to fetch agent card from a link-local address: ${hostname}`,
    );
  }
}

/**
 * Fetches `url` with redirects disabled, refusing instead of following one.
 *
 * `DefaultAgentCardResolver`'s own fetch follows redirects by default, which
 * would make the request itself reach wherever a compromised or
 * misconfigured card endpoint points it -- before this module's own
 * same-origin check on the card's declared RPC URLs ever runs. A redirect
 * to an internal or metadata address is a real request either way,
 * regardless of whether the resulting content later fails that check.
 *
 * A response whose `status` is 0 covers both an opaque redirect
 * (`type: 'opaqueredirect'`, from `redirect: 'manual'` crossing an
 * actually-followed-elsewhere boundary) and a network error
 * (`type: 'error'`): neither carries a usable `location`, so both are
 * refused the same way, with `location` reported as `null`.
 */
async function refuseRedirectFetch(
  url: string | URL | Request,
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const response = await fetch(url, {...init, redirect: 'manual'});
  if (
    response.status === 0 ||
    (response.status >= 300 && response.status < 400)
  ) {
    const location = response.headers.get('location');
    throw new Error(
      `Refusing to follow a redirect from the agent card endpoint ` +
        `(status ${response.status}, location ${location}): ${url}`,
    );
  }
  return response;
}

/**
 * {@link refuseRedirectFetch} that also sends the active trace context, so the
 * card fetch joins the caller's trace.
 */
const tracePropagatingRefuseRedirectFetch =
  propagateTraceContext(refuseRedirectFetch);

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
      `Failed to read agent card from file ${source}: ${getErrorMessage(err)}`,
      {cause: err},
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
 * Skill-level security requirements as defined by the A2A specification.
 *
 * Each record maps a security scheme name to an array of required scopes.
 * The array represents a logical OR of requirement objects.
 */
export type SkillSecurity = Array<Record<string, string[]>>;

const SKILL_SECURITY_METADATA_KEY = 'security';

const AGENT_CARD_BUILDER_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.agentCardBuilder',
);

/**
 * Options for {@link AgentCardBuilder}.
 */
export interface AgentCardBuilderOptions {
  /** The ADK `BaseAgent` or `Workflow` to build an `AgentCard` for. */
  agent: RunnableRoot;
  /** The RPC URL advertised on the card (default: `'http://localhost:80/a2a'`). */
  rpcUrl?: string;
  /** Optional A2A capabilities advertised on the card (default: `{streaming: true}`). */
  capabilities?: AgentCapabilities;
  /** Optional documentation URL (`documentationUrl` on the resulting `AgentCard`). */
  docUrl?: string;
  /** Optional service provider metadata. */
  provider?: AgentProvider;
  /** Optional version string for the agent (default: `'0.0.1'`). */
  agentVersion?: string;
  /** Optional security scheme declarations included on the card. */
  securitySchemes?: Record<string, SecurityScheme>;
  /**
   * Optional default security requirements applied to all generated skills
   * unless overridden per tool via `BaseTool.customMetadata['security']`.
   */
  defaultSkillSecurity?: SkillSecurity;
  /** Optional list of transport interfaces advertised on the card. */
  transports?: AgentInterface[];
}

/**
 * Optional security configuration forwarded to {@link getA2AAgentCard}.
 */
export interface GetA2AAgentCardOptions {
  /** Optional security scheme declarations included on the card. */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Optional default security requirements applied to generated skills. */
  defaultSkillSecurity?: SkillSecurity;
}

function describeNodeType(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return (
      (value as {constructor?: {name?: string}}).constructor?.name ?? 'object'
    );
  }
  return typeof value;
}

/**
 * Builder class for creating A2A `AgentCard` objects from ADK agents and workflows.
 *
 * Skill-level security requirements can be set across all generated skills via
 * {@link AgentCardBuilderOptions.defaultSkillSecurity}, while individual tools
 * can override requirements via `BaseTool.customMetadata['security']`. Security
 * schemes and skill security populate card metadata only and are not enforced
 * at runtime.
 */
export class AgentCardBuilder {
  readonly [AGENT_CARD_BUILDER_SIGNATURE_SYMBOL] = true;

  private readonly agent: RunnableRoot;
  private readonly rpcUrl: string;
  private readonly capabilities: AgentCapabilities;
  private readonly docUrl?: string;
  private readonly provider?: AgentProvider;
  private readonly securitySchemes?: Record<string, SecurityScheme>;
  private readonly defaultSkillSecurity?: SkillSecurity;
  private readonly agentVersion: string;
  private readonly transports?: AgentInterface[];

  constructor(options: AgentCardBuilderOptions) {
    if (!options?.agent) {
      throw new Error('Agent cannot be null or undefined.');
    }
    if (!isRunnableRoot(options.agent)) {
      throw new TypeError(
        `AgentCardBuilder requires a BaseAgent or Workflow, got ${describeNodeType(options.agent)}.`,
      );
    }
    if (
      options.defaultSkillSecurity !== undefined &&
      !isSkillSecurity(options.defaultSkillSecurity)
    ) {
      throw new Error(
        'defaultSkillSecurity must be an Array<Record<string, string[]>>.',
      );
    }

    this.agent = options.agent;
    this.rpcUrl = options.rpcUrl || 'http://localhost:80/a2a';
    this.capabilities = options.capabilities ?? {streaming: true};
    this.docUrl = options.docUrl;
    this.provider = options.provider;
    this.securitySchemes = options.securitySchemes;
    this.defaultSkillSecurity = options.defaultSkillSecurity;
    this.agentVersion = options.agentVersion || '0.0.1';
    this.transports = options.transports;
  }

  /**
   * Builds and returns the complete A2A `AgentCard`.
   */
  async build(): Promise<AgentCard> {
    try {
      const primarySkills = await buildPrimarySkills(
        this.agent,
        this.defaultSkillSecurity,
      );
      const subAgentSkills = await buildSubAgentSkills(
        this.agent,
        this.defaultSkillSecurity,
      );
      const allSkills = [...primarySkills, ...subAgentSkills];

      validateSkillSecurityReferences(allSkills, this.securitySchemes ?? {});

      const cleanUrl = this.rpcUrl.replace(/\/+$/, '');
      const card: AgentCard = {
        name: this.agent.name,
        description: this.agent.description || 'An ADK Agent',
        url: this.transports?.[0]?.url ?? cleanUrl,
        version: this.agentVersion,
        protocolVersion: '0.3.0',
        preferredTransport: this.transports?.[0]?.transport ?? 'JSONRPC',
        capabilities: this.capabilities,
        skills: allSkills,
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        supportsAuthenticatedExtendedCard: false,
      };
      if (this.docUrl !== undefined) {
        card.documentationUrl = this.docUrl;
      }
      if (this.provider !== undefined) {
        card.provider = this.provider;
      }
      if (this.securitySchemes !== undefined) {
        card.securitySchemes = this.securitySchemes;
      }
      if (this.transports !== undefined) {
        card.additionalInterfaces = this.transports;
      }
      return card;
    } catch (e: unknown) {
      throw new Error(
        `Failed to build agent card for ${this.agent.name}: ${getErrorMessage(e)}`,
        {cause: e},
      );
    }
  }
}

/**
 * Converts an ADK agent to an A2A AgentCard.
 */
export async function getA2AAgentCard(
  agent: RunnableRoot,
  transports: AgentInterface[],
  options?: GetA2AAgentCardOptions,
): Promise<AgentCard> {
  if (
    options?.defaultSkillSecurity !== undefined &&
    !isSkillSecurity(options.defaultSkillSecurity)
  ) {
    throw new Error(
      'defaultSkillSecurity must be an Array<Record<string, string[]>>.',
    );
  }
  const skills = await buildAgentSkills(agent, options?.defaultSkillSecurity);
  validateSkillSecurityReferences(skills, options?.securitySchemes ?? {});

  const card: AgentCard = {
    name: agent.name,
    description: agent.description || '',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    skills,
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
  if (options?.securitySchemes !== undefined) {
    card.securitySchemes = options.securitySchemes;
  }
  return card;
}

/**
 * Builds a list of AgentSkills based on agent descriptions and types.
 * This information can be used in AgentCard to help clients understand agent capabilities.
 *
 * @param agent The agent to build skills for.
 * @param defaultSkillSecurity Optional default security requirements for generated skills.
 * @returns A promise resolving to a list of AgentSkills.
 */
export async function buildAgentSkills(
  agent: RunnableRoot,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  if (isWorkflow(agent)) {
    // A workflow advertises itself as one skill in `buildAgentSkills`.
    return [
      buildSkillObject({
        id: agent.name,
        name: 'workflow',
        description: agent.description || `Workflow ${agent.name}`,
        tags: ['workflow'],
        security: defaultSkillSecurity,
      }),
    ];
  }
  const [primarySkills, subAgentSkills] = await Promise.all([
    buildPrimarySkills(agent, defaultSkillSecurity),
    buildSubAgentSkills(agent, defaultSkillSecurity),
  ]);

  return [...primarySkills, ...subAgentSkills];
}

function buildSkillObject(params: {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: SkillSecurity;
}): AgentSkill {
  const skill: AgentSkill = {
    id: params.id,
    name: params.name,
    description: params.description,
    tags: params.tags,
  };
  if (params.examples !== undefined) {
    skill.examples = params.examples;
  }
  if (params.inputModes !== undefined) {
    skill.inputModes = params.inputModes;
  }
  if (params.outputModes !== undefined) {
    skill.outputModes = params.outputModes;
  }
  if (params.security !== undefined) {
    skill.security = params.security;
  }
  return skill;
}

/**
 * Returns the immediate child nodes of an agent or a workflow.
 */
export function iterChildNodes(agent: BaseNode): BaseNode[] {
  if (isBaseAgent(agent)) {
    return [...agent.subAgents];
  }
  if (isWorkflow(agent) && agent.graph) {
    return agent.graph.nodes.filter((n) => n.name !== START.name);
  }
  return [];
}

/**
 * Builds primary skills for any node type.
 */
export async function buildPrimarySkills(
  agent: BaseNode,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  if (isLlmAgent(agent)) {
    return buildLlmAgentSkills(agent, defaultSkillSecurity);
  }
  return buildNonLlmAgentSkills(agent, defaultSkillSecurity);
}

/**
 * Builds skills for all immediate child nodes (sub-agents or workflow nodes).
 */
export async function buildSubAgentSkills(
  agent: BaseNode,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  const result: AgentSkill[] = [];

  for (const sub of iterChildNodes(agent)) {
    try {
      const skills = await buildPrimarySkills(sub, defaultSkillSecurity);
      for (const subSkill of skills) {
        result.push(
          buildSkillObject({
            id: `${sub.name}_${subSkill.id}`,
            name: `${sub.name}: ${subSkill.name}`,
            description: subSkill.description,
            examples: subSkill.examples,
            inputModes: subSkill.inputModes,
            outputModes: subSkill.outputModes,
            tags: [`sub_agent:${sub.name}`, ...(subSkill.tags ?? [])],
            security: subSkill.security,
          }),
        );
      }
    } catch (e: unknown) {
      logger.warn(
        `Failed to build skills for sub-agent ${sub.name}: ${getErrorMessage(e)}`,
      );
      continue;
    }
  }

  return result;
}

/**
 * Builds skills for an `LlmAgent`.
 */
export async function buildLlmAgentSkills(
  agent: LlmAgent,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  // The card is a discovery document served without authentication (even when
  // the A2A RPC endpoints require authentication), so the skill description
  // comes from the agent's own public description and never from its
  // instructions.
  const agentDescription = buildAgentDescription(agent);
  const agentExamples = await extractExamplesFromAgent(agent);
  const extractedInputs =
    agentExamples !== undefined
      ? extractInputsFromExamples(agentExamples)
      : undefined;

  const skills: AgentSkill[] = [
    buildSkillObject({
      id: agent.name,
      name: 'model',
      description: agentDescription,
      examples: extractedInputs,
      outputModes: getOutputModes(agent),
      tags: ['llm'],
      security: defaultSkillSecurity,
    }),
  ];

  if (agent.tools && agent.tools.length > 0) {
    const toolSkills = await buildToolSkills(agent, defaultSkillSecurity);
    skills.push(...toolSkills);
  }

  if (agent.planner) {
    skills.push(buildPlannerSkill(agent, defaultSkillSecurity));
  }

  if (agent.codeExecutor) {
    skills.push(buildCodeExecutorSkill(agent, defaultSkillSecurity));
  }

  return skills;
}

/**
 * Builds skills for an `LlmAgent`'s canonical tools, skipping `ExampleTool`.
 */
export async function buildToolSkills(
  agent: LlmAgent,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  const toolSkills: AgentSkill[] = [];
  const canonicalTools = await agent.canonicalTools();

  for (const tool of canonicalTools) {
    if (isExampleTool(tool)) {
      continue;
    }

    const toolName = tool.name || describeNodeType(tool);
    const toolSecurity = getToolSecurity(tool, defaultSkillSecurity);

    toolSkills.push(
      buildSkillObject({
        id: `${agent.name}-${toolName}`,
        name: toolName,
        description: tool.description || `Tool: ${toolName}`,
        tags: ['llm', 'tools'],
        security: toolSecurity,
      }),
    );
  }

  return toolSkills;
}

/**
 * Builds the planner skill for an `LlmAgent`.
 */
export function buildPlannerSkill(
  agent: LlmAgent,
  defaultSkillSecurity?: SkillSecurity,
): AgentSkill {
  return buildSkillObject({
    id: `${agent.name}-planner`,
    name: 'planning',
    description: 'Can think about the tasks to do and make plans',
    tags: ['llm', 'planning'],
    security: defaultSkillSecurity,
  });
}

/**
 * Builds the code executor skill for an `LlmAgent`.
 */
export function buildCodeExecutorSkill(
  agent: LlmAgent,
  defaultSkillSecurity?: SkillSecurity,
): AgentSkill {
  return buildSkillObject({
    id: `${agent.name}-code-executor`,
    name: 'code-execution',
    description: 'Can execute code',
    tags: ['llm', 'code_execution'],
    security: defaultSkillSecurity,
  });
}

/**
 * Builds skills for non-LLM agents and workflow nodes.
 */
export async function buildNonLlmAgentSkills(
  agent: BaseNode,
  defaultSkillSecurity?: SkillSecurity,
): Promise<AgentSkill[]> {
  const agentDescription = buildAgentDescription(agent);
  const agentExamples = await extractExamplesFromAgent(agent);
  const extractedInputs =
    agentExamples !== undefined
      ? extractInputsFromExamples(agentExamples)
      : undefined;
  const agentType = getAgentTypeTag(agent);
  const agentName = getAgentSkillName(agent);

  const skills: AgentSkill[] = [
    buildSkillObject({
      id: agent.name,
      name: agentName,
      description: agentDescription,
      examples: extractedInputs,
      outputModes: getOutputModes(agent),
      tags: [agentType],
      security: defaultSkillSecurity,
    }),
  ];

  if (iterChildNodes(agent).length > 0) {
    const orchestrationSkill = buildOrchestrationSkill(
      agent,
      agentType,
      defaultSkillSecurity,
    );
    if (orchestrationSkill) {
      skills.push(orchestrationSkill);
    }
  }

  return skills;
}

/**
 * Builds the orchestration skill for agents or workflows with child nodes.
 */
export function buildOrchestrationSkill(
  agent: BaseNode,
  agentType: string,
  defaultSkillSecurity?: SkillSecurity,
): AgentSkill | undefined {
  const childNodes = iterChildNodes(agent);
  if (childNodes.length === 0) {
    return undefined;
  }

  const subAgentDescriptions = childNodes.map(
    (sub) => `${sub.name}: ${sub.description || 'No description'}`,
  );

  return buildSkillObject({
    id: `${agent.name}-sub-agents`,
    name: 'sub-agents',
    description: `Orchestrates: ${subAgentDescriptions.join('; ')}`,
    tags: [agentType, 'orchestration'],
    security: defaultSkillSecurity,
  });
}

/**
 * Returns whether `value` matches `Array<Record<string, string[]>>`.
 */
export function isSkillSecurity(value: unknown): value is SkillSecurity {
  return (
    Array.isArray(value) &&
    value.every(
      (req) =>
        typeof req === 'object' &&
        req !== null &&
        !Array.isArray(req) &&
        Object.entries(req).every(
          ([scheme, scopes]) =>
            typeof scheme === 'string' &&
            Array.isArray(scopes) &&
            scopes.every((scope) => typeof scope === 'string'),
        ),
    )
  );
}

/**
 * Gets security requirements for a tool from `customMetadata['security']`,
 * falling back to `defaultSkillSecurity`.
 */
export function getToolSecurity(
  tool: unknown,
  defaultSkillSecurity?: SkillSecurity,
): SkillSecurity | undefined {
  if (
    isBaseTool(tool) &&
    tool.customMetadata &&
    SKILL_SECURITY_METADATA_KEY in tool.customMetadata
  ) {
    const security = tool.customMetadata[SKILL_SECURITY_METADATA_KEY];
    if (isSkillSecurity(security)) {
      return security;
    }
    const toolName = tool.name || describeNodeType(tool);
    logger.warn(
      `Tool "${toolName}" customMetadata['security'] does not match Array<Record<string, string[]>>; ignoring and falling back to defaultSkillSecurity.`,
    );
  }
  return defaultSkillSecurity;
}

/**
 * Validates that skill security references match declared security schemes on
 * the agent card, logging a warning for any undeclared scheme reference.
 */
export function validateSkillSecurityReferences(
  skills: AgentSkill[],
  securitySchemes: Record<string, SecurityScheme>,
): void {
  const schemeNames = new Set(Object.keys(securitySchemes));
  for (const skill of skills) {
    if (!skill.security) {
      continue;
    }
    for (const requirement of skill.security) {
      for (const refName of Object.keys(requirement)) {
        if (!schemeNames.has(refName)) {
          logger.warn(
            `Skill "${skill.id}" references security scheme "${refName}" which is not declared in securitySchemes. Declared schemes: ${JSON.stringify([...schemeNames].sort())}`,
          );
        }
      }
    }
  }
}

/**
 * Builds the description for an agent or workflow node.
 */
export function buildAgentDescription(agent: BaseNode): string {
  const descriptionParts: string[] = [];

  if (agent.description) {
    descriptionParts.push(agent.description);
  }

  if (!isLlmAgent(agent)) {
    const workflowDescription = getWorkflowDescription(agent);
    if (workflowDescription) {
      descriptionParts.push(workflowDescription);
    }
  }

  if (descriptionParts.length > 0) {
    return descriptionParts.join(' ');
  } else {
    return getDefaultAgentDescription(agent);
  }
}

/**
 * Returns the workflow-specific description for non-LLM agents and workflows.
 */
export function getWorkflowDescription(agent: BaseNode): string | undefined {
  if (iterChildNodes(agent).length === 0) {
    return undefined;
  }

  if (isSequentialAgent(agent)) {
    return buildSequentialAgentDescription(agent);
  } else if (isParallelAgent(agent)) {
    return buildParallelAgentDescription(agent);
  } else if (isLoopAgent(agent)) {
    return buildLoopAgentDescription(agent);
  } else if (isWorkflow(agent)) {
    return buildGraphWorkflowDescription(agent);
  }

  return undefined;
}

/**
 * Builds the description for a sequential workflow agent.
 */
export function buildSequentialAgentDescription(agent: BaseAgent): string {
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

/**
 * Builds the description for a parallel workflow agent.
 */
export function buildParallelAgentDescription(agent: BaseAgent): string {
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

/**
 * Builds the description for a loop workflow agent.
 */
export function buildLoopAgentDescription(agent: LoopAgent): string {
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

/**
 * Builds the description for a graph-based `Workflow`.
 */
export function buildGraphWorkflowDescription(workflow: Workflow): string {
  const childNodes = iterChildNodes(workflow);
  const descriptions = childNodes.map((childNode) => {
    const nodeDescription = childNode.description
      ? childNode.description.replace(/\.+$/, '')
      : `execute the ${childNode.name} node`;
    return `${childNode.name}: ${nodeDescription}`;
  });
  return `This workflow orchestrates the following nodes: ${descriptions.join('; ')}.`;
}

/**
 * Returns the default description based on agent type.
 */
export function getDefaultAgentDescription(agent: BaseNode): string {
  if (isLoopAgent(agent)) {
    return 'A loop workflow agent';
  } else if (isSequentialAgent(agent)) {
    return 'A sequential workflow agent';
  } else if (isParallelAgent(agent)) {
    return 'A parallel workflow agent';
  } else if (isLlmAgent(agent)) {
    return 'An LLM-based agent';
  } else if (isWorkflow(agent)) {
    return 'A graph-based workflow agent';
  } else {
    return 'A custom agent';
  }
}

/**
 * Returns the agent type tag for skill tagging.
 */
export function getAgentTypeTag(agent: BaseNode): string {
  if (isLoopAgent(agent)) {
    return 'loop_workflow';
  } else if (isSequentialAgent(agent)) {
    return 'sequential_workflow';
  } else if (isParallelAgent(agent)) {
    return 'parallel_workflow';
  } else if (isLlmAgent(agent)) {
    return 'llm';
  } else if (isWorkflow(agent)) {
    return 'graph_workflow';
  } else {
    return 'custom_agent';
  }
}

/**
 * Returns the skill name based on agent type.
 */
export function getAgentSkillName(agent: BaseNode): string {
  if (isLlmAgent(agent)) {
    return 'model';
  }
  if (isCompositeShellAgent(agent) || isWorkflow(agent)) {
    return 'workflow';
  }
  return 'custom';
}

function isCompositeShellAgent(agent: BaseNode): boolean {
  return (
    isLoopAgent(agent) || isSequentialAgent(agent) || isParallelAgent(agent)
  );
}

/**
 * Extracts only the input strings from converted examples so they can be added
 * to an `AgentSkill`.
 */
export function extractInputsFromExamples(
  examples?: Array<Record<string, unknown>>,
): string[] {
  if (!examples) {
    return [];
  }

  const extractedInputs: string[] = [];
  for (const example of examples) {
    const exampleInput = example['input'];
    if (
      typeof exampleInput !== 'object' ||
      exampleInput === null ||
      Array.isArray(exampleInput)
    ) {
      continue;
    }

    const inputRecord = exampleInput as Record<string, unknown>;
    const parts = inputRecord['parts'];
    if (Array.isArray(parts)) {
      const partTexts: string[] = [];
      for (const part of parts) {
        if (typeof part !== 'object' || part === null || Array.isArray(part)) {
          continue;
        }
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') {
          partTexts.push(text);
        }
      }
      if (partTexts.length > 0) {
        extractedInputs.push(partTexts.join('\n'));
      }
    } else {
      const text = inputRecord['text'];
      if (typeof text === 'string') {
        extractedInputs.push(text);
      }
    }
  }

  return extractedInputs;
}

/**
 * Extracts examples from an agent's configured `ExampleTool`, if any.
 */
export async function extractExamplesFromAgent(
  agent: BaseNode,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!isLlmAgent(agent)) {
    return undefined;
  }

  try {
    const canonicalTools = await agent.canonicalTools();
    for (const tool of canonicalTools) {
      if (isExampleTool(tool)) {
        const examples = convertExampleToolExamples(tool);
        if (examples !== undefined) {
          return examples;
        }
      }
    }
  } catch (e: unknown) {
    logger.warn(`Failed to extract examples from tools: ${getErrorMessage(e)}`);
  }

  // Examples come only from a declared ExampleTool, never mined out of the
  // instruction, which is not publishable content.
  return undefined;
}

/**
 * Converts static `ExampleTool` examples to `{input, output}` records, skipping
 * dynamic `BaseExampleProvider` instances.
 */
export function convertExampleToolExamples(
  tool: ExampleTool,
): Array<Record<string, unknown>> | undefined {
  if (isBaseExampleProvider(tool.examples) || !Array.isArray(tool.examples)) {
    logger.debug(
      'Skipping dynamic ExampleTool provider when building an agent card',
    );
    return undefined;
  }

  return tool.examples.map((example) => ({
    input: example.input,
    output: [...example.output],
  }));
}

/**
 * Returns output modes from `LlmAgent.generateContentConfig.responseModalities`.
 */
export function getOutputModes(agent: BaseNode): string[] | undefined {
  if (!isLlmAgent(agent)) {
    return undefined;
  }
  return agent.generateContentConfig?.responseModalities;
}
