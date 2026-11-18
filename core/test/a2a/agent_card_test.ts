/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  buildAgentDescription,
  buildAgentSkills,
  buildCodeExecutorSkill,
  buildGraphWorkflowDescription,
  buildLlmAgentSkills,
  buildLoopAgentDescription,
  buildOrchestrationSkill,
  buildParallelAgentDescription,
  buildPlannerSkill,
  buildSequentialAgentDescription,
  buildSubAgentSkills,
  buildToolSkills,
  convertExampleToolExamples,
  extractExamplesFromAgent,
  extractInputsFromExamples,
  getAgentSkillName,
  getAgentTypeTag,
  getDefaultAgentDescription,
  getOutputModes,
  getToolSecurity,
  getWorkflowDescription,
  resolveAgentCard,
  ResolveAgentCardOptions,
  validateSkillSecurityReferences,
} from '../../src/a2a/agent_card.js';
import {logger} from '../../src/utils/logger.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

import {
  AGENT_CARD_PATH,
  type AgentCard,
  type AgentProvider,
  type SecurityScheme,
} from '@a2a-js/sdk';
import {
  AgentCardBuilder,
  type AgentCardBuilderOptions,
  BaseAgent,
  BaseExampleProvider,
  BaseTool,
  BaseToolset,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  ExampleTool,
  FunctionTool,
  getA2AAgentCard,
  isAgentCardResolutionError,
  isExampleTool,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
  type SkillSecurity,
  START,
  toA2a,
} from '@google/adk';

/**
 * The `{all: true}` overload of `dns.lookup` the guard calls, declared here so
 * the mock is typed without casting through the overloaded signature.
 */
type LookupAll = (
  hostname: string,
  options: {all: true},
) => Promise<Array<{address: string; family: number}>>;

const lookupMock = vi.hoisted(() => vi.fn<LookupAll>());

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

/** The card a stubbed agent-card endpoint or temp file serves. */
const STUB_CARD = {
  name: 'peer_agent',
  description: 'A peer agent',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'http://localhost:8001/a2a/peer_agent/',
  capabilities: {streaming: true},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [],
};

/** Builds the 200 response an agent-card endpoint returns. */
function cardResponse(): Response {
  return new Response(JSON.stringify(STUB_CARD), {
    headers: {'content-type': 'application/json'},
  });
}

// Minimal CustomAgent for testing BaseAgent path
class CustomAgent extends BaseAgent {
  constructor(name: string, description?: string, subAgents?: BaseAgent[]) {
    super({
      name,
      description,
      subAgents,
    });
  }

  protected async *runAsyncImpl() {
    yield* [];
  }

  protected async *runLiveImpl() {
    yield* [];
  }
}

class MockToolset extends BaseToolset {
  constructor(private readonly tools: BaseTool[]) {
    super([]);
  }
  async getTools() {
    return this.tools;
  }
  async close() {}
}

describe('Agent Card', () => {
  const dummyTransport = {
    transport: 'grpc',
    url: 'grpc://localhost:8080',
  };

  describe('getA2AAgentCard', () => {
    it('creates a basic agent card for a custom agent', async () => {
      const agent = new CustomAgent('test_agent', 'A custom test agent');

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      expect(card.name).toBe('test_agent');
      expect(card.description).toBe('A custom test agent');
      expect(card.url).toBe('grpc://localhost:8080');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.skills).toHaveLength(1);

      const skill = card.skills[0];
      expect(skill.name).toBe('custom');
      expect(skill.id).toBe('test_agent');
      expect(skill.tags).toContain('custom_agent');
    });

    it('identifies LlmAgent and builds skills correctly', async () => {
      const tool1 = new FunctionTool({
        name: 'test_tool',
        description: 'Test tool 1',
        execute: async () => 'ok',
      });
      const toolset = new MockToolset([
        new FunctionTool({
          name: 'inner_tool',
          execute: async () => 'ok',
          description: 'Inner tool',
        }),
      ]);

      const agent = new LlmAgent({
        name: 'llm_agent',
        description: 'An LLM agent',
        instruction: 'You are a helpful assistant',
        tools: [tool1, toolset],
      });

      const card = await getA2AAgentCard(agent, [dummyTransport]);

      // Skills should include: the model itself, and tools
      expect(card.skills).toHaveLength(3); // 1 model + 1 tool1 + 1 inner_tool

      const modelSkill = card.skills.find((s) => s.name === 'model');
      expect(modelSkill).toBeDefined();
      expect(modelSkill?.description).toBe('An LLM agent');

      const toolSkill = card.skills.find((s) => s.name === 'test_tool');
      expect(toolSkill).toBeDefined();
      expect(toolSkill?.description).toBe('Test tool 1');

      const innerToolSkill = card.skills.find((s) => s.name === 'inner_tool');
      expect(innerToolSkill).toBeDefined();
    });

    it('works with workflow agents and builds correct orchestration descriptions', async () => {
      const sub1 = new CustomAgent('sub1', 'fetch data');
      const sub2 = new CustomAgent('sub2', 'process data');

      const seqAgent = new SequentialAgent({
        name: 'seq_agent',
        subAgents: [sub1, sub2],
      });

      const card = await getA2AAgentCard(seqAgent, [dummyTransport]);
      expect(card.description).toBe('');
      expect(card.skills.length).toBeGreaterThan(1);

      const seqSkill = card.skills.find((s) => s.name === 'workflow');
      expect(seqSkill).toBeDefined();
      expect(seqSkill?.description).toBe(
        'First, this agent will fetch data. Finally, this agent will process data.',
      );

      const orchestrationSkill = card.skills.find(
        (s) => s.name === 'sub-agents',
      );
      expect(orchestrationSkill).toBeDefined();
      expect(orchestrationSkill?.description).toContain('fetch data');
    });

    it('omits instructions from the published card', async () => {
      const reviewer = new LlmAgent({
        name: 'reviewer',
        description: 'Reviews the reply.',
        instruction: 'ZZ_SUB_INSTRUCTION_SENTINEL reject unsigned requests.',
      });
      const root = new LlmAgent({
        name: 'writer',
        description: 'Writes a short reply.',
        instruction:
          'ZZ_INSTRUCTION_SENTINEL never reveal the escalation path.',
        globalInstruction: 'ZZ_GLOBAL_SENTINEL always answer in English.',
        subAgents: [reviewer],
      });

      const card = await getA2AAgentCard(root, [dummyTransport]);

      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain('ZZ_INSTRUCTION_SENTINEL');
      expect(serialized).not.toContain('ZZ_GLOBAL_SENTINEL');
      expect(serialized).not.toContain('ZZ_SUB_INSTRUCTION_SENTINEL');

      const primarySkill = card.skills.find((s) => s.id === 'writer');
      expect(primarySkill?.description).toBe('Writes a short reply.');
      const reviewerSkill = card.skills.find(
        (s) => s.id === 'reviewer_reviewer',
      );
      expect(reviewerSkill?.description).toBe('Reviews the reply.');
    });

    it('does not invoke dynamic instruction providers when building the card', async () => {
      const dynamicInstruction = vi.fn(
        async () => 'ZZ_DYNAMIC_INSTRUCTION_SENTINEL',
      );
      const dynamicGlobalInstruction = vi.fn(
        async () => 'ZZ_DYNAMIC_GLOBAL_SENTINEL',
      );
      const dynamicSubInstruction = vi.fn(
        () => 'ZZ_DYNAMIC_SUB_INSTRUCTION_SENTINEL',
      );
      const dynamicSub = new LlmAgent({
        name: 'dynamic_sub',
        description: 'Uses a dynamic instruction.',
        instruction: dynamicSubInstruction,
      });
      const root = new LlmAgent({
        name: 'dyn_global_root',
        instruction: dynamicInstruction,
        globalInstruction: dynamicGlobalInstruction,
        subAgents: [dynamicSub],
      });

      const card = await getA2AAgentCard(root, [dummyTransport]);

      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain('ZZ_DYNAMIC_INSTRUCTION_SENTINEL');
      expect(serialized).not.toContain('ZZ_DYNAMIC_GLOBAL_SENTINEL');
      expect(serialized).not.toContain('ZZ_DYNAMIC_SUB_INSTRUCTION_SENTINEL');
      expect(dynamicInstruction).not.toHaveBeenCalled();
      expect(dynamicGlobalInstruction).not.toHaveBeenCalled();
      expect(dynamicSubInstruction).not.toHaveBeenCalled();

      const primarySkill = card.skills.find((s) => s.id === 'dyn_global_root');
      expect(primarySkill?.description).toBe('An LLM-based agent');
      const subSkill = card.skills.find(
        (s) => s.id === 'dynamic_sub_dynamic_sub',
      );
      expect(subSkill?.description).toBe('Uses a dynamic instruction.');
    });

    it('omits LlmAgent child instructions from composite and workflow cards', async () => {
      const seqAgent = new SequentialAgent({
        name: 'seq_root',
        subAgents: [
          new LlmAgent({
            name: 'seq_child',
            description: 'Seq child desc',
            instruction: 'ZZ_SEQ_CHILD_SENTINEL',
          }),
        ],
      });
      const parAgent = new ParallelAgent({
        name: 'par_root',
        subAgents: [
          new LlmAgent({
            name: 'par_child',
            description: 'Par child desc',
            instruction: 'ZZ_PAR_CHILD_SENTINEL',
          }),
        ],
      });
      const loopAgent = new LoopAgent({
        name: 'loop_root',
        maxIterations: 2,
        subAgents: [
          new LlmAgent({
            name: 'loop_child',
            description: 'Loop child desc',
            instruction: 'ZZ_LOOP_CHILD_SENTINEL',
          }),
        ],
      });
      const workflowAgent = new Workflow({
        name: 'wf_root',
        description: 'Workflow desc',
        edges: [
          [
            'START',
            new LlmAgent({
              name: 'wf_child',
              description: 'Wf child desc',
              instruction: 'ZZ_WF_CHILD_SENTINEL',
            }),
          ],
        ],
      });

      const cards = await Promise.all([
        getA2AAgentCard(seqAgent, [dummyTransport]),
        getA2AAgentCard(parAgent, [dummyTransport]),
        getA2AAgentCard(loopAgent, [dummyTransport]),
        getA2AAgentCard(workflowAgent, [dummyTransport]),
      ]);

      const serialized = JSON.stringify(cards);
      expect(serialized).not.toContain('ZZ_SEQ_CHILD_SENTINEL');
      expect(serialized).not.toContain('ZZ_PAR_CHILD_SENTINEL');
      expect(serialized).not.toContain('ZZ_LOOP_CHILD_SENTINEL');
      expect(serialized).not.toContain('ZZ_WF_CHILD_SENTINEL');
    });

    it('serves /.well-known/agent-card.json via toA2a without leaking instructions', async () => {
      const agent = new LlmAgent({
        name: 'support-agent',
        description: 'Customer support agent',
        instruction: 'ZZ_HTTP_INSTRUCTION_SENTINEL',
        globalInstruction: 'ZZ_HTTP_GLOBAL_SENTINEL',
        subAgents: [
          new LlmAgent({
            name: 'sub-support',
            description: 'Sub support agent',
            instruction: 'ZZ_HTTP_SUB_SENTINEL',
          }),
        ],
      });

      const app = await toA2a(agent, {
        authentication: async () => ({
          isAuthenticated: false,
          userName: '',
        }),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          resolve();
        });
      });
      try {
        const port = (server.address() as AddressInfo).port;
        const response = await fetch(
          `http://127.0.0.1:${port}/${AGENT_CARD_PATH}`,
        );
        expect(response.status).toBe(200);
        const bodyText = await response.text();
        expect(bodyText).not.toContain('ZZ_HTTP_INSTRUCTION_SENTINEL');
        expect(bodyText).not.toContain('ZZ_HTTP_GLOBAL_SENTINEL');
        expect(bodyText).not.toContain('ZZ_HTTP_SUB_SENTINEL');

        const card = JSON.parse(bodyText) as AgentCard;
        expect(card.name).toBe('support-agent');
        expect(card.description).toBe('Customer support agent');
        const primarySkill = card.skills.find((s) => s.id === 'support-agent');
        expect(primarySkill?.description).toBe('Customer support agent');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  describe('resolveAgentCard', () => {
    // Card responses in this suite are served by a real local http server so
    // resolveAgentCard's actual network fetch path is exercised, not a mock
    // of the SDK's resolver -- the vulnerability this suite pins was in how
    // a genuinely-fetched card's contents were (not) checked.

    function baseCard(url: string, extra: Partial<AgentCard> = {}) {
      return {
        name: 'test-agent',
        description: '',
        protocolVersion: '0.3.0',
        version: '1.0.0',
        url,
        preferredTransport: 'JSONRPC',
        capabilities: {},
        skills: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        ...extra,
      };
    }

    async function withCardServer<T>(
      cardFactory: (port: number) => object,
      fn: (source: string) => Promise<T>,
      bindHost = '127.0.0.1',
    ): Promise<T> {
      const server = http.createServer((req, res) => {
        const port = (server.address() as AddressInfo).port;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(cardFactory(port)));
      });
      await new Promise<void>((resolve) => server.listen(0, bindHost, resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        return await fn(`http://${bindHost}:${port}`);
      } finally {
        server.close();
      }
    }

    /**
     * Returns the address of a non-loopback IPv4 interface on this machine,
     * or `undefined` if none is configured (e.g. a fully network-isolated
     * CI sandbox with only a loopback interface). Used to exercise the
     * scheme check's non-loopback branch against a real, locally-bindable
     * address rather than an external domain this environment can't
     * actually route a request to and get back.
     */
    function findNonLoopbackIPv4(): string | undefined {
      const interfaces = os.networkInterfaces();
      for (const addrs of Object.values(interfaces)) {
        for (const addr of addrs ?? []) {
          if (addr.family === 'IPv4' && !addr.internal) {
            return addr.address;
          }
        }
      }
      return undefined;
    }

    it('accepts a card whose RPC url shares the fetch origin', async () => {
      await withCardServer(
        (port) => baseCard(`http://127.0.0.1:${port}/rpc`),
        async (source) => {
          const card = await resolveAgentCard(source);
          expect(card.url).toBe(`${source}/rpc`);
        },
      );
    });

    it('accepts a same-origin additionalInterfaces entry', async () => {
      await withCardServer(
        (port) =>
          baseCard(`http://127.0.0.1:${port}/rpc`, {
            additionalInterfaces: [
              {transport: 'JSONRPC', url: `http://127.0.0.1:${port}/rpc2`},
            ],
          }),
        async (source) => {
          const card = await resolveAgentCard(source);
          expect(card.url).toBe(`${source}/rpc`);
        },
      );
    });

    it('rejects an off-origin RPC url on a fetched card', async () => {
      // The reported vulnerability: a card fetched from a trusted,
      // configured source can declare an RPC url pointing anywhere at
      // all, and it was followed with no check that it matched where the
      // card actually came from.
      await withCardServer(
        () => baseCard('https://attacker.example.net/rpc'),
        async (source) => {
          await expect(resolveAgentCard(source)).rejects.toThrow(/same origin/);
        },
      );
    });

    it('rejects an off-origin additionalInterfaces entry even when the primary url is same-origin', async () => {
      // Every url the card offers must be checked, not only the one a
      // particular transport negotiation would pick.
      await withCardServer(
        (port) =>
          baseCard(`http://127.0.0.1:${port}/rpc`, {
            additionalInterfaces: [
              {transport: 'JSONRPC', url: 'https://attacker.example.net/rpc2'},
            ],
          }),
        async (source) => {
          await expect(resolveAgentCard(source)).rejects.toThrow(/same origin/);
        },
      );
    });

    it('does not validate a directly-provided card object', async () => {
      // A card passed in directly (or read from a local file) did not
      // come off the network here; its target is left to the caller.
      const card = await resolveAgentCard(
        baseCard('https://anywhere.example.com/rpc') as AgentCard,
      );
      expect(card.url).toBe('https://anywhere.example.com/rpc');
    });

    it('rejects a same-origin http url on a non-loopback host', async () => {
      // Every existing case above serves from 127.0.0.1, so none of them
      // ever reach the scheme check -- isLoopbackHost is always true
      // there, regardless of what it's fixed to accept or reject. This
      // pins that branch specifically, isolated from the origin check
      // (the url below shares the fetch origin exactly).
      const nonLoopback = findNonLoopbackIPv4();
      if (!nonLoopback) {
        // No non-loopback IPv4 interface on this machine (e.g. a fully
        // network-isolated sandbox) -- nothing to bind to.
        return;
      }
      await withCardServer(
        (port) => baseCard(`http://${nonLoopback}:${port}/rpc`),
        async (source) => {
          await expect(resolveAgentCard(source)).rejects.toThrow(
            /must use https, or http on a loopback host/,
          );
        },
        nonLoopback,
      );
    });

    it('rejects a card with an empty url', async () => {
      await withCardServer(
        () => baseCard(''),
        async (source) => {
          await expect(resolveAgentCard(source)).rejects.toThrow(
            /Invalid RPC URL/,
          );
        },
      );
    });

    describe('loopback origin comparison', () => {
      // Different loopback hostnames all name this same machine in
      // practice: adk-js's own toA2a defaults host to localhost, and
      // `adk deploy` passes --host=0.0.0.0, which a request to
      // 0.0.0.0:<port> does reach. A plain origin-string comparison would
      // treat these as different origins and break both flows.
      it('accepts localhost source with a 127.0.0.1 rpc url', async () => {
        const server = http.createServer((req, res) => {
          const port = (server.address() as AddressInfo).port;
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify(baseCard(`http://127.0.0.1:${port}/rpc`)));
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        try {
          const port = (server.address() as AddressInfo).port;
          const card = await resolveAgentCard(`http://localhost:${port}`);
          expect(card.url).toBe(`http://127.0.0.1:${port}/rpc`);
        } finally {
          server.close();
        }
      });

      it('accepts a 0.0.0.0 source with a 0.0.0.0 rpc url', async () => {
        // A server bound to 0.0.0.0 (as `adk deploy --host=0.0.0.0` runs
        // one) listens on every interface, including 127.0.0.1, so the
        // fetch itself goes through 127.0.0.1 while the card's own
        // declared url uses 0.0.0.0 -- the shape such a server actually
        // reports for itself.
        const server = http.createServer((req, res) => {
          const port = (server.address() as AddressInfo).port;
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify(baseCard(`http://0.0.0.0:${port}/rpc`)));
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '0.0.0.0', resolve),
        );
        try {
          const port = (server.address() as AddressInfo).port;
          const card = await resolveAgentCard(`http://127.0.0.1:${port}`);
          expect(card.url).toBe(`http://0.0.0.0:${port}/rpc`);
        } finally {
          server.close();
        }
      });

      it('accepts an IPv6 wildcard source with an IPv6 wildcard rpc url', async () => {
        // Not every environment supports binding to the IPv6 wildcard
        // address (this sandbox's kernel does not) -- skip gracefully
        // rather than fail the suite on an environment limitation, the
        // same reasoning as findNonLoopbackIPv4()'s skip above.
        const server = http.createServer((req, res) => {
          const port = (server.address() as AddressInfo).port;
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify(baseCard(`http://[::]:${port}/rpc`)));
        });
        const bound = await new Promise<boolean>((resolve) => {
          server.once('error', () => resolve(false));
          server.listen(0, '::', () => resolve(true));
        });
        if (!bound) {
          return;
        }
        try {
          const port = (server.address() as AddressInfo).port;
          const card = await resolveAgentCard(`http://[::1]:${port}`);
          expect(card.url).toBe(`http://[::]:${port}/rpc`);
        } finally {
          server.close();
        }
      });

      it('still rejects two loopback origins that differ on port', async () => {
        await withCardServer(
          (port) => baseCard(`http://127.0.0.1:${port + 1}/rpc`),
          async (source) => {
            await expect(resolveAgentCard(source)).rejects.toThrow(
              /same origin/,
            );
          },
        );
      });
    });

    describe('resolveAgentCardOptions escape hatches', () => {
      it('allowInsecureRpc accepts a same-origin http url on a non-loopback host, with a warning', async () => {
        const nonLoopback = findNonLoopbackIPv4();
        if (!nonLoopback) {
          return;
        }
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
          await withCardServer(
            (port) => baseCard(`http://${nonLoopback}:${port}/rpc`),
            async (source) => {
              const options: ResolveAgentCardOptions = {
                allowInsecureRpc: true,
              };
              const card = await resolveAgentCard(source, options);
              expect(card.url).toBe(`${source}/rpc`);
            },
            nonLoopback,
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('allowCrossOriginRpc accepts an off-origin RPC url, with a warning', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        try {
          await withCardServer(
            () => baseCard('https://api.example.com/rpc'),
            async (source) => {
              const options: ResolveAgentCardOptions = {
                allowCrossOriginRpc: true,
              };
              const card = await resolveAgentCard(source, options);
              expect(card.url).toBe('https://api.example.com/rpc');
            },
          );
        } finally {
          warn.mockRestore();
        }
      });

      it('still rejects an off-origin RPC url when allowCrossOriginRpc is not set', async () => {
        // Pins that the escape hatch defaults to false: omitting the
        // options object entirely (the shape every other test in this
        // file already uses) must keep failing closed.
        await withCardServer(
          () => baseCard('https://api.example.com/rpc'),
          async (source) => {
            await expect(resolveAgentCard(source)).rejects.toThrow(
              /same origin/,
            );
          },
        );
      });
    });
  });

  describe('buildAgentSkills', () => {
    it('excludes instructions and global instructions from LlmAgent skill descriptions', async () => {
      const agent = new LlmAgent({
        name: 'test_agent',
        description: 'Test agent',
        instruction: 'You should help users.',
        globalInstruction: 'Your role is to assist.',
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('Test agent');
    });

    it('falls back to the default description when an LlmAgent has instructions but no description', async () => {
      const mockProvider = vi
        .fn()
        .mockResolvedValue('You are dynamically created');
      const agent = new LlmAgent({
        name: 'dyn_agent',
        instruction: mockProvider,
        globalInstruction: 'You are global',
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('An LLM-based agent');
      expect(mockProvider).not.toHaveBeenCalled();
    });

    it('excludes root globalInstruction when building skills for a sub-agent', async () => {
      const properRoot = new LlmAgent({
        name: 'root',
        globalInstruction: 'You are global',
        subAgents: [
          new LlmAgent({
            name: 'sub',
            description: 'Sub agent description',
            instruction: 'You are sub',
          }),
        ],
      });

      const properlyWiredSub = properRoot.subAgents[0] as LlmAgent;

      const skills = await buildAgentSkills(properlyWiredSub);
      const modelSkill = skills.find((s) => s.name === 'model');

      expect(modelSkill?.description).toBe('Sub agent description');
    });

    it('supports parallel agent description', async () => {
      const sub1 = new CustomAgent('sub1', 'do A');
      const sub2 = new CustomAgent('sub2', 'do B');

      const parAgent = new ParallelAgent({
        name: 'par_agent',
        subAgents: [sub1, sub2],
      });

      const skills = await buildAgentSkills(parAgent);
      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe(
        'This agent will do A and do B simultaneously.',
      );
    });

    it('supports loop agent description', async () => {
      const sub1 = new CustomAgent('sub1', 'do A');
      const sub2 = new CustomAgent('sub2', 'do B');

      const loopAgent = new LoopAgent({
        name: 'loop_agent',
        subAgents: [sub1, sub2],
        maxIterations: 5,
      });

      const skills = await buildAgentSkills(loopAgent);
      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe(
        'This agent will do A and do B in a loop (max 5 iterations).',
      );
    });

    it('classifies a graph Workflow as a workflow, not a custom agent', async () => {
      const agent = new Workflow({
        name: 'graph_workflow',
        description: 'Runs a graph',
        edges: [['START', node(() => 'done', {name: 'step'})]],
      });

      const skills = await buildAgentSkills(agent);

      const workflowSkill = skills.find((s) => s.name === 'workflow');
      expect(workflowSkill?.description).toBe('Runs a graph');
      expect(skills.find((s) => s.name === 'custom')).toBeUndefined();
    });

    it('publishes a code-execution skill for an agent with a code executor', async () => {
      const agent = new LlmAgent({
        name: 'coder',
        description: 'Writes code',
        codeExecutor: new BuiltInCodeExecutor(),
      });

      const skills = await buildAgentSkills(agent);

      const codeSkill = skills.find((s) => s.id === 'coder-code-executor');
      expect(codeSkill).toBeDefined();
      expect(codeSkill?.name).toBe('code-execution');
      expect(codeSkill?.description).toBe('Can execute code');
      expect(codeSkill?.tags).toEqual(['llm', 'code_execution']);
    });

    it('publishes no code-execution skill for an agent without a code executor', async () => {
      const agent = new LlmAgent({
        name: 'coder',
        description: 'Writes code',
      });

      const skills = await buildAgentSkills(agent);

      expect(skills.find((s) => s.name === 'code-execution')).toBeUndefined();
      expect(skills).toHaveLength(1);
    });

    it('appends the code-execution skill after the tool skills', async () => {
      const agent = new LlmAgent({
        name: 'coder',
        description: 'Writes code',
        tools: [
          new FunctionTool({
            name: 'lookup',
            description: 'Looks something up',
            execute: async () => 'ok',
          }),
        ],
        codeExecutor: new BuiltInCodeExecutor(),
      });

      const skills = await buildAgentSkills(agent);

      expect(skills.map((s) => s.name)).toEqual([
        'model',
        'lookup',
        'code-execution',
      ]);
    });

    it('prefixes the code-execution skill of a sub-agent', async () => {
      const root = new LlmAgent({
        name: 'root',
        description: 'Delegates to a coder',
        subAgents: [
          new LlmAgent({
            name: 'coder',
            description: 'Writes code',
            codeExecutor: new BuiltInCodeExecutor(),
          }),
        ],
      });

      const skills = await buildAgentSkills(root);

      const codeSkill = skills.find((s) => s.name === 'coder: code-execution');
      expect(codeSkill).toBeDefined();
      expect(codeSkill?.id).toBe('coder_coder-code-executor');
      expect(codeSkill?.description).toBe('Can execute code');
      expect(codeSkill?.tags).toEqual([
        'sub_agent:coder',
        'llm',
        'code_execution',
      ]);
    });
  });

  describe('resolveAgentCard', () => {
    let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
    let tempDir: string;
    let cardPath: string;

    beforeEach(async () => {
      fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      lookupMock.mockReset();
      tempDir = await mkdtemp(join(tmpdir(), 'adk-agent-card-'));
      cardPath = join(tempDir, 'card.json');
      await writeFile(cardPath, JSON.stringify(STUB_CARD), 'utf-8');
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await rm(tempDir, {recursive: true, force: true});
    });

    it('returns an AgentCard object without any I/O', async () => {
      const card = await resolveAgentCard(STUB_CARD);

      expect(card).toBe(STUB_CARD);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      'http://169.254.169.254/',
      'http://[fe80::1]/',
      'http://[64:ff9b::a9fe:a9fe]/',
    ])('refuses the link-local literal %s without fetching', async (source) => {
      await expect(resolveAgentCard(source)).rejects.toThrow(
        /Refusing to fetch agent card from a link-local address/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a hostname that resolves to a link-local address', async () => {
      resolveTo('169.254.169.254');

      await expect(
        resolveAgentCard('http://cards.example.com/'),
      ).rejects.toThrow(
        'Refusing to fetch agent card from a link-local address: cards.example.com',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a hostname that resolves to both a global and a link-local address', async () => {
      resolveTo('93.184.216.34', '169.254.169.254');

      await expect(
        resolveAgentCard('http://cards.example.com/'),
      ).rejects.toThrow(
        /Refusing to fetch agent card from a link-local address/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a redirect instead of following it', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: {location: 'http://169.254.169.254/'},
        }),
      );

      await expect(
        resolveAgentCard('http://cards.example.com/'),
      ).rejects.toThrow(
        /Refusing to follow a redirect .* \(status 302, location http:\/\/169\.254\.169\.254\/\)/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({redirect: 'manual'}),
      );
    });

    it('refuses an opaque redirect response', async () => {
      resolveTo('93.184.216.34');
      fetchMock.mockResolvedValue(Response.error());

      await expect(
        resolveAgentCard('http://cards.example.com/'),
      ).rejects.toThrow(/status 0, location null/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['http://localhost:8001/a2a/agent/', 'http://127.0.0.1:8001/'])(
      'fetches the card from the loopback URL %s',
      async (source) => {
        resolveTo('127.0.0.1');
        fetchMock.mockResolvedValue(cardResponse());

        const card = await resolveAgentCard(source);

        expect(card.name).toBe('peer_agent');
        expect(fetchMock.mock.calls[0][0].toString()).toBe(
          `${source}.well-known/agent-card.json`,
        );
      },
    );

    it('fetches the card from a private address', async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            ...STUB_CARD,
            url: 'https://10.0.0.5/a2a/peer_agent/',
          }),
          {headers: {'content-type': 'application/json'}},
        ),
      );

      const card = await resolveAgentCard('https://10.0.0.5/');

      expect(card.name).toBe('peer_agent');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      'ftp://cards.example.com/card.json',
      'gopher://cards.example.com/',
      'htp://cards.example.com/card.json',
      'data:application/json,{}',
    ])('refuses the unsupported scheme in %s', async (source) => {
      const rejection = resolveAgentCard(source);

      await expect(rejection).rejects.toThrow(
        /Unsupported agent card URL scheme/,
      );
      await expect(rejection).rejects.not.toThrow(
        /Failed to read agent card from file/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the card from a filesystem path', async () => {
      const card = await resolveAgentCard(cardPath);

      expect(card.name).toBe('peer_agent');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the card from a file:// URL', async () => {
      const card = await resolveAgentCard(pathToFileURL(cardPath).href);

      expect(card.name).toBe('peer_agent');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a Windows drive letter as a path, not a scheme', async () => {
      await expect(resolveAgentCard('C:\\cards\\card.json')).rejects.toThrow(
        /^Failed to read agent card from file C:\\cards\\card\.json: /,
      );
    });

    it('reports a missing card file with its source', async () => {
      await expect(
        resolveAgentCard('./no-such-agent-card.json'),
      ).rejects.toThrow(
        /^Failed to read agent card from file \.\/no-such-agent-card\.json: ENOENT/,
      );
    });

    describe('failure of a URL or file source', () => {
      /** Returns the value `resolveAgentCard(source)` rejects with. */
      async function rejectionOf(source: string): Promise<unknown> {
        try {
          await resolveAgentCard(source);
        } catch (e: unknown) {
          return e;
        }
        return expect.fail(`Resolving ${source} did not reject.`);
      }

      it('wraps a refused link-local address and keeps the cause', async () => {
        const error = await rejectionOf('http://169.254.169.254/');

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.name).toBe('AgentCardResolutionError');
        expect(error.message).toBe(
          'Refusing to fetch agent card from a link-local address: 169.254.169.254',
        );
        expect(error.cause).toEqual(new Error(error.message));
        expect(isAgentCardResolutionError(error.cause)).toBe(false);
      });

      it('wraps a failed card fetch', async () => {
        const failure = new TypeError('fetch failed');
        fetchMock.mockRejectedValue(failure);

        const error = await rejectionOf('https://10.0.0.5/');

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toBe('fetch failed');
        expect(error.cause).toBe(failure);
      });

      it('wraps a refused RPC url of a fetched card', async () => {
        fetchMock.mockResolvedValue(cardResponse());

        const error = await rejectionOf('https://10.0.0.5/');

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toMatch(/must have the same origin/);
      });

      it('wraps an unsupported URL scheme', async () => {
        const error = await rejectionOf('ftp://cards.example.com/card.json');

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toMatch(/^Unsupported agent card URL scheme/);
      });

      it('wraps a missing card file and keeps the file system error', async () => {
        const error = await rejectionOf(join(tempDir, 'missing-card.json'));

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.cause).toMatchObject({
          message: error.message,
          cause: {code: 'ENOENT'},
        });
      });

      it('wraps a card file that is not valid JSON', async () => {
        await writeFile(cardPath, '{"name": ', 'utf-8');

        const error = await rejectionOf(cardPath);

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toMatch(
          /^Failed to read agent card from file .*card\.json: /,
        );
        expect(error.cause).toMatchObject({cause: {name: 'SyntaxError'}});
      });
    });

    describe('trimming and card URL validation', () => {
      async function rejectionOfCard(
        source: AgentCard | string,
      ): Promise<unknown> {
        try {
          await resolveAgentCard(source);
        } catch (e: unknown) {
          return e;
        }
        return expect.fail('Resolving the agent card did not reject.');
      }

      it('trims padded URL and file path sources before resolving', async () => {
        fetchMock.mockResolvedValue(
          new Response(
            JSON.stringify({
              ...STUB_CARD,
              url: 'https://10.0.0.5/a2a/peer_agent/',
            }),
            {headers: {'content-type': 'application/json'}},
          ),
        );

        const fromUrl = await resolveAgentCard('  https://10.0.0.5/  ');
        const fromFile = await resolveAgentCard(`  ${cardPath}  `);

        expect(fromUrl.name).toBe('peer_agent');
        expect(fromFile.name).toBe('peer_agent');
      });

      it.each(['', '   '])(
        'rejects an empty or whitespace-only source string %j',
        async (source) => {
          const error = await rejectionOfCard(source);

          expect(isAgentCardResolutionError(error)).toBe(true);
        },
      );

      it.each([
        {name: 'missing url', card: {...STUB_CARD, url: undefined}},
        {name: 'empty url', card: {...STUB_CARD, url: ''}},
        {name: 'whitespace url', card: {...STUB_CARD, url: '   '}},
        {name: 'invalid url', card: {...STUB_CARD, url: 'invalid-url'}},
        {
          name: 'scheme without host',
          card: {...STUB_CARD, url: 'mailto:agent@example.com'},
        },
      ])('rejects a direct card object with $name', async ({card}) => {
        const error = await rejectionOfCard(card as unknown as AgentCard);

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toMatch(/Invalid RPC URL/);
      });

      it.each([
        {name: 'missing url', payload: {...STUB_CARD, url: undefined}},
        {name: 'empty url', payload: {...STUB_CARD, url: ''}},
        {name: 'invalid url', payload: {...STUB_CARD, url: 'invalid-url'}},
        {
          name: 'scheme without host',
          payload: {...STUB_CARD, url: 'mailto:agent@example.com'},
        },
      ])('rejects a card file with $name', async ({payload}) => {
        await writeFile(cardPath, JSON.stringify(payload), 'utf-8');

        const error = await rejectionOfCard(cardPath);

        if (!isAgentCardResolutionError(error)) {
          return expect.fail('The error is not an AgentCardResolutionError.');
        }
        expect(error.message).toMatch(/Invalid RPC URL/);
      });

      it.each([null, []])(
        'rejects a non-object card payload %j from object and file sources',
        async (payload) => {
          await writeFile(cardPath, JSON.stringify(payload), 'utf-8');

          const directError = await rejectionOfCard(
            payload as unknown as AgentCard,
          );
          const fileError = await rejectionOfCard(cardPath);

          expect(isAgentCardResolutionError(directError)).toBe(true);
          expect(isAgentCardResolutionError(fileError)).toBe(true);
        },
      );
    });
  });

  describe('AgentCardBuilder', () => {
    const apiKeyScheme: SecurityScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };

    it('builds an agent card with default parameters', async () => {
      const agent = new CustomAgent('test_agent', 'Test agent description');
      const builder = new AgentCardBuilder({agent});

      const card = await builder.build();

      expect(card.name).toBe('test_agent');
      expect(card.description).toBe('Test agent description');
      expect(card.documentationUrl).toBeUndefined();
      expect(card.url).toBe('http://localhost:80/a2a');
      expect(card.version).toBe('0.0.1');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.preferredTransport).toBe('JSONRPC');
      expect(card.capabilities).toEqual({streaming: true});
      expect(card.defaultInputModes).toEqual(['text/plain']);
      expect(card.defaultOutputModes).toEqual(['text/plain']);
      expect(card.supportsAuthenticatedExtendedCard).toBe(false);
      expect(card.provider).toBeUndefined();
      expect(card.securitySchemes).toBeUndefined();
      expect(card.skills).toHaveLength(1);
    });

    it('builds an agent card with custom parameters and strips trailing slashes on rpcUrl', async () => {
      const agent = new CustomAgent('test_agent');
      const provider: AgentProvider = {
        organization: 'ACME',
        url: 'https://acme.example.com',
      };
      const securitySchemes: Record<string, SecurityScheme> = {
        apiKey: apiKeyScheme,
      };
      const options: AgentCardBuilderOptions = {
        agent,
        rpcUrl: 'https://example.com/a2a/',
        capabilities: {streaming: true, pushNotifications: true},
        docUrl: 'https://docs.example.com',
        provider,
        agentVersion: '2.0.0',
        securitySchemes,
      };

      const card = await new AgentCardBuilder(options).build();

      expect(card.name).toBe('test_agent');
      expect(card.description).toBe('An ADK Agent');
      expect(card.documentationUrl).toBe('https://docs.example.com');
      expect(card.url).toBe('https://example.com/a2a');
      expect(card.version).toBe('2.0.0');
      expect(card.capabilities).toEqual({
        streaming: true,
        pushNotifications: true,
      });
      expect(card.provider).toEqual(provider);
      expect(card.securitySchemes).toEqual(securitySchemes);
    });

    it.each([undefined, null])(
      'throws when agent is %s',
      (invalidAgent: unknown) => {
        expect(
          () =>
            new AgentCardBuilder({
              agent: invalidAgent as BaseAgent,
            }),
        ).toThrow('Agent cannot be null or undefined.');
      },
    );

    it('throws TypeError when agent is a bare FunctionNode', () => {
      const fnNode = node(async (input: unknown) => `echo: ${String(input)}`, {
        name: 'echo_fn',
      });

      expect(
        () =>
          new AgentCardBuilder({
            agent: fnNode as unknown as BaseAgent,
          }),
      ).toThrow(/requires a BaseAgent or Workflow, got FunctionNode/);
    });

    it('throws TypeError when agent is not a BaseAgent or Workflow', () => {
      expect(
        () =>
          new AgentCardBuilder({
            agent: 'not an agent' as unknown as BaseAgent,
          }),
      ).toThrow(/requires a BaseAgent or Workflow, got string/);
    });

    it.each([
      {label: 'an object instead of an array', value: {oauth2: ['agent.read']}},
      {label: 'an array of strings', value: ['oauth2']},
      {
        label: 'a scope value that is a string',
        value: [{oauth2: 'agent.read'}],
      },
      {
        label: 'a scope array with a non-string entry',
        value: [{oauth2: [123]}],
      },
    ])('rejects invalid defaultSkillSecurity ($label)', ({value}) => {
      const agent = new CustomAgent('test_agent');

      expect(
        () =>
          new AgentCardBuilder({
            agent,
            defaultSkillSecurity: value as unknown as SkillSecurity,
          }),
      ).toThrow(
        'defaultSkillSecurity must be an Array<Record<string, string[]>>.',
      );
    });

    it('wraps skill-building failures with the agent name and cause', async () => {
      const brokenToolset = {
        getTools: async () => {
          throw new Error('Toolset load error');
        },
        close: async () => {},
      } as unknown as BaseToolset;
      const agent = new LlmAgent({
        name: 'test_agent',
        tools: [brokenToolset],
      });
      vi.spyOn(agent, 'canonicalTools').mockRejectedValue(
        new Error('Test error'),
      );

      const builder = new AgentCardBuilder({agent});

      await expect(builder.build()).rejects.toThrow(
        'Failed to build agent card for test_agent: Test error',
      );
    });

    it('builds a card for a standalone LlmAgent', async () => {
      const agent = new LlmAgent({
        name: 'writer',
        model: 'gemini-flash-latest',
        description: 'Writes a short reply.',
        instruction: 'Write a short reply.',
      });

      const card = await new AgentCardBuilder({
        agent,
        rpcUrl: 'http://localhost:8000/',
      }).build();

      expect(card.name).toBe('writer');
      expect(card.description).toBe('Writes a short reply.');
      expect(card.skills.map((s) => s.id)).toContain('writer');
    });

    it('omits instructions, global instructions, and instruction-embedded examples from the built card', async () => {
      const reviewer = new LlmAgent({
        name: 'reviewer',
        model: 'gemini-flash-latest',
        description: 'Reviews the reply.',
        instruction: 'ZZ_SUB_INSTRUCTION_SENTINEL reject unsigned requests.',
      });
      const root = new LlmAgent({
        name: 'writer',
        model: 'gemini-flash-latest',
        description: 'Writes a short reply.',
        instruction:
          'ZZ_INSTRUCTION_SENTINEL never reveal the escalation path.\n' +
          'Example Query: "ZZ_EXAMPLE_QUERY_SENTINEL"\n' +
          'Example Response: "ZZ_EXAMPLE_RESPONSE_SENTINEL"',
        globalInstruction: 'ZZ_GLOBAL_SENTINEL always answer in English.',
        subAgents: [reviewer],
      });

      const card = await new AgentCardBuilder({
        agent: root,
        rpcUrl: 'http://localhost:8000/',
      }).build();

      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain('ZZ_INSTRUCTION_SENTINEL');
      expect(serialized).not.toContain('ZZ_GLOBAL_SENTINEL');
      expect(serialized).not.toContain('ZZ_SUB_INSTRUCTION_SENTINEL');
      expect(serialized).not.toContain('ZZ_EXAMPLE_QUERY_SENTINEL');
      expect(serialized).not.toContain('ZZ_EXAMPLE_RESPONSE_SENTINEL');
      const primarySkill = card.skills.find((s) => s.id === 'writer');
      expect(primarySkill?.description).toBe('Writes a short reply.');
    });

    it('skips dynamic request-scoped instruction providers when building the card', async () => {
      const dynamicInstruction = vi.fn(async () => {
        throw new Error('request-scoped instruction must not be called');
      });
      const agent = new LlmAgent({
        name: 'dynamic_writer',
        description: 'Writes dynamic replies.',
        model: 'gemini-flash-latest',
        instruction: dynamicInstruction,
      });

      const card = await new AgentCardBuilder({agent}).build();

      const modelSkill = card.skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toBe('Writes dynamic replies.');
      expect(dynamicInstruction).not.toHaveBeenCalled();
    });

    it('builds a card for a Workflow with an LlmAgent node', async () => {
      const writer = new LlmAgent({
        name: 'writer',
        model: 'gemini-flash-latest',
        description: 'Writes the reply.',
        instruction: 'Write a short reply.',
      });
      const workflow = new Workflow({
        name: 'pipe',
        description: 'A simple pipeline.',
        edges: [[START, writer]],
      });

      const card = await new AgentCardBuilder({
        agent: workflow,
        rpcUrl: 'http://localhost:8000/',
      }).build();

      expect(card.name).toBe('pipe');
      const skillIds = card.skills.map((s) => s.id);
      expect(skillIds).toContain('pipe');
      expect(skillIds.some((id) => id.includes('writer'))).toBe(true);
    });

    it('builds a card for a Workflow whose LlmAgent node has an outputSchema', async () => {
      const writer = new LlmAgent({
        name: 'writer',
        model: 'gemini-flash-latest',
        instruction: 'Write a short reply.',
        outputSchema: z.object({text: z.string()}),
      });
      const workflow = new Workflow({
        name: 'pipe',
        edges: [[START, writer]],
      });

      const card = await new AgentCardBuilder({
        agent: workflow,
        rpcUrl: 'http://localhost:8000/',
      }).build();

      expect(card.name).toBe('pipe');
      const primarySkill = card.skills.find((s) => s.id === 'pipe');
      expect(primarySkill?.tags).toContain('graph_workflow');
    });

    it('builds a card for a Workflow with no static graph nodes', async () => {
      const workflow = new Workflow({
        name: 'empty_wf',
        description: 'An empty workflow.',
        dynamicEntry: async () => undefined,
      });

      const card = await new AgentCardBuilder({
        agent: workflow,
        rpcUrl: 'http://localhost:8000/',
      }).build();

      expect(card.name).toBe('empty_wf');
      expect(card.description).toBe('An empty workflow.');
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0]?.tags).toContain('graph_workflow');
    });
  });

  describe('agent card helper functions', () => {
    it('returns the expected agent type tag for each agent and workflow class', () => {
      const llm = new LlmAgent({name: 'llm'});
      const seq = new SequentialAgent({name: 'seq', subAgents: []});
      const par = new ParallelAgent({name: 'par', subAgents: []});
      const loop = new LoopAgent({name: 'loop', subAgents: []});
      const wf = new Workflow({
        name: 'wf',
        dynamicEntry: async () => undefined,
      });
      const custom = new CustomAgent('custom');

      expect(getAgentTypeTag(llm)).toBe('llm');
      expect(getAgentTypeTag(seq)).toBe('sequential_workflow');
      expect(getAgentTypeTag(par)).toBe('parallel_workflow');
      expect(getAgentTypeTag(loop)).toBe('loop_workflow');
      expect(getAgentTypeTag(wf)).toBe('graph_workflow');
      expect(getAgentTypeTag(custom)).toBe('custom_agent');
    });

    it('returns the expected skill name for each agent and workflow class', () => {
      const llm = new LlmAgent({name: 'llm'});
      const seq = new SequentialAgent({name: 'seq', subAgents: []});
      const par = new ParallelAgent({name: 'par', subAgents: []});
      const loop = new LoopAgent({name: 'loop', subAgents: []});
      const wf = new Workflow({
        name: 'wf',
        dynamicEntry: async () => undefined,
      });
      const custom = new CustomAgent('custom');

      expect(getAgentSkillName(llm)).toBe('model');
      expect(getAgentSkillName(seq)).toBe('workflow');
      expect(getAgentSkillName(par)).toBe('workflow');
      expect(getAgentSkillName(loop)).toBe('workflow');
      expect(getAgentSkillName(wf)).toBe('workflow');
      expect(getAgentSkillName(custom)).toBe('custom');
    });

    it('returns the expected default description for each agent and workflow class', () => {
      const llm = new LlmAgent({name: 'llm'});
      const seq = new SequentialAgent({name: 'seq', subAgents: []});
      const par = new ParallelAgent({name: 'par', subAgents: []});
      const loop = new LoopAgent({name: 'loop', subAgents: []});
      const wf = new Workflow({
        name: 'wf',
        dynamicEntry: async () => undefined,
      });
      const custom = new CustomAgent('custom');

      expect(getDefaultAgentDescription(llm)).toBe('An LLM-based agent');
      expect(getDefaultAgentDescription(seq)).toBe(
        'A sequential workflow agent',
      );
      expect(getDefaultAgentDescription(par)).toBe('A parallel workflow agent');
      expect(getDefaultAgentDescription(loop)).toBe('A loop workflow agent');
      expect(getDefaultAgentDescription(wf)).toBe(
        'A graph-based workflow agent',
      );
      expect(getDefaultAgentDescription(custom)).toBe('A custom agent');
    });

    it('returns responseModalities from LlmAgent generateContentConfig when configured', () => {
      const withModalities = new LlmAgent({
        name: 'llm_with_modalities',
        generateContentConfig: {
          responseModalities: ['text/plain', 'application/json'],
        },
      });
      const withoutModalities = new LlmAgent({
        name: 'llm_without_modalities',
        generateContentConfig: {},
      });
      const withoutConfig = new LlmAgent({name: 'llm_default'});
      withoutConfig.generateContentConfig = undefined;
      const custom = new CustomAgent('custom');

      expect(getOutputModes(withModalities)).toEqual([
        'text/plain',
        'application/json',
      ]);
      expect(getOutputModes(withoutModalities)).toBeUndefined();
      expect(getOutputModes(withoutConfig)).toBeUndefined();
      expect(getOutputModes(custom)).toBeUndefined();
    });

    it('builds agent descriptions with and without explicit descriptions', () => {
      const withDesc = new CustomAgent('a1', 'Test agent description');
      const withoutDesc = new CustomAgent('a2');

      expect(buildAgentDescription(withDesc)).toBe('Test agent description');
      expect(buildAgentDescription(withoutDesc)).toBe('A custom agent');
    });

    it('builds workflow descriptions for SequentialAgent, ParallelAgent, LoopAgent, and Workflow', () => {
      const makeSub = (name: string, description?: string) =>
        new CustomAgent(name, description);

      const seqSingle = new SequentialAgent({
        name: 'seq1',
        subAgents: [makeSub('agent1', 'First agent')],
      });
      const seqMulti = new SequentialAgent({
        name: 'seq3',
        subAgents: [
          makeSub('agent1', 'First agent'),
          makeSub('agent2', 'Second agent'),
          makeSub('agent3', 'Third agent'),
        ],
      });
      const seqUnnamed = new SequentialAgent({
        name: 'seq_unnamed',
        subAgents: [makeSub('agent1'), makeSub('agent2')],
      });
      const seqEmpty = new SequentialAgent({name: 'seq_empty', subAgents: []});

      expect(buildSequentialAgentDescription(seqSingle)).toBe(
        'First, this agent will First agent.',
      );
      expect(buildSequentialAgentDescription(seqMulti)).toBe(
        'First, this agent will First agent. Then, this agent will Second agent. Finally, this agent will Third agent.',
      );
      expect(buildSequentialAgentDescription(seqUnnamed)).toBe(
        'First, this agent will execute the agent1 agent. Finally, this agent will execute the agent2 agent.',
      );
      expect(getWorkflowDescription(seqEmpty)).toBeUndefined();

      const parSingle = new ParallelAgent({
        name: 'par1',
        subAgents: [makeSub('agent1', 'First agent')],
      });
      const parMulti = new ParallelAgent({
        name: 'par3',
        subAgents: [
          makeSub('agent1', 'First agent'),
          makeSub('agent2', 'Second agent'),
          makeSub('agent3', 'Third agent'),
        ],
      });
      expect(buildParallelAgentDescription(parSingle)).toBe(
        'This agent will First agent simultaneously.',
      );
      expect(buildParallelAgentDescription(parMulti)).toBe(
        'This agent will First agent , Second agent and Third agent simultaneously.',
      );

      const loopSingle = new LoopAgent({
        name: 'loop1',
        subAgents: [makeSub('agent1', 'First agent')],
        maxIterations: 3,
      });
      const loopUnlimited = new LoopAgent({
        name: 'loop_unlimited',
        subAgents: [makeSub('agent1', 'First agent')],
      });
      const loopZero = new LoopAgent({
        name: 'loop_zero',
        subAgents: [makeSub('agent1', 'First agent')],
        maxIterations: 0,
      });
      expect(buildLoopAgentDescription(loopSingle)).toBe(
        'This agent will First agent in a loop (max 3 iterations).',
      );
      expect(getWorkflowDescription(loopUnlimited)).toBe(
        'This agent will First agent in a loop (max unlimited iterations).',
      );
      expect(getWorkflowDescription(loopZero)).toBe(
        'This agent will First agent in a loop (max 0 iterations).',
      );

      const customWithSub = new CustomAgent('custom', undefined, [
        makeSub('agent1', 'First agent'),
      ]);
      expect(getWorkflowDescription(customWithSub)).toBeUndefined();

      const writer = new LlmAgent({
        name: 'writer',
        model: 'gemini-flash-latest',
        description: 'Writes the reply.',
      });
      const reviewer = new LlmAgent({
        name: 'reviewer',
        model: 'gemini-flash-latest',
        description: 'Reviews the reply',
      });
      const wfWithNodes = new Workflow({
        name: 'pipe',
        edges: [
          [START, writer],
          [writer, reviewer],
        ],
      });
      const wfEmpty = new Workflow({
        name: 'empty_wf',
        dynamicEntry: async () => undefined,
      });

      expect(buildGraphWorkflowDescription(wfWithNodes)).toBe(
        'This workflow orchestrates the following nodes: writer: Writes the reply; reviewer: Reviews the reply.',
      );
      expect(getWorkflowDescription(wfWithNodes)).toContain(
        'writer: Writes the reply',
      );
      expect(getWorkflowDescription(wfEmpty)).toBeUndefined();
    });

    it('builds orchestration skills for agents with and without sub-agent descriptions', () => {
      const sub1 = new CustomAgent('agent1', 'First agent description');
      const sub2 = new CustomAgent('agent2', 'Second agent description');
      const mainAgent = new CustomAgent('main_agent', undefined, [sub1, sub2]);

      const skill = buildOrchestrationSkill(mainAgent, 'sequential_workflow');
      expect(skill).toEqual({
        id: 'main_agent-sub-agents',
        name: 'sub-agents',
        description:
          'Orchestrates: agent1: First agent description; agent2: Second agent description',
        tags: ['sequential_workflow', 'orchestration'],
      });

      const unnamedAgent = new CustomAgent('main_agent', undefined, [
        new CustomAgent('agent1'),
        new CustomAgent('agent2'),
      ]);
      const fallbackSkill = buildOrchestrationSkill(
        unnamedAgent,
        'parallel_workflow',
      );
      expect(fallbackSkill?.description).toBe(
        'Orchestrates: agent1: No description; agent2: No description',
      );

      const emptyAgent = new CustomAgent('empty_agent');
      expect(
        buildOrchestrationSkill(emptyAgent, 'custom_agent'),
      ).toBeUndefined();
    });

    it('extracts examples from static ExampleTool and skips dynamic BaseExampleProvider', async () => {
      const exampleTool = new ExampleTool([
        {
          input: {role: 'user', parts: [{text: 'What is the weather?'}]},
          output: [{role: 'model', parts: [{text: 'The weather is sunny.'}]}],
        },
        {
          input: {role: 'user', parts: [{text: 'What time is it?'}]},
          output: [{role: 'model', parts: [{text: 'It is 3 PM.'}]}],
        },
      ]);
      expect(isExampleTool(exampleTool)).toBe(true);
      expect(isExampleTool({})).toBe(false);

      const converted = convertExampleToolExamples(exampleTool);
      expect(converted).toHaveLength(2);
      expect(extractInputsFromExamples(converted)).toEqual([
        'What is the weather?',
        'What time is it?',
      ]);
      expect(
        extractInputsFromExamples([
          {
            input: {text: 'Plain text input'},
            output: [{text: 'Plain text output'}],
          },
        ]),
      ).toEqual(['Plain text input']);
      expect(extractInputsFromExamples(undefined)).toEqual([]);

      const emptyTool = new ExampleTool([]);
      expect(convertExampleToolExamples(emptyTool)).toEqual([]);

      class DynamicProvider extends BaseExampleProvider {
        async getExamples() {
          return [];
        }
      }
      const dynamicTool = new ExampleTool(new DynamicProvider());
      expect(convertExampleToolExamples(dynamicTool)).toBeUndefined();

      const agentWithExamples = new LlmAgent({
        name: 'weather_agent',
        description: 'Answers weather questions',
        tools: [
          exampleTool,
          new FunctionTool({
            name: 'get_forecast',
            description: 'Gets forecast',
            execute: async () => 'sunny',
          }),
        ],
        planner: new BuiltInPlanner({thinkingConfig: {includeThoughts: true}}),
      });

      const extracted = await extractExamplesFromAgent(agentWithExamples);
      expect(extracted).toHaveLength(2);

      const skills = await buildLlmAgentSkills(agentWithExamples);
      const modelSkill = skills.find((s) => s.id === 'weather_agent');
      expect(modelSkill?.examples).toEqual([
        'What is the weather?',
        'What time is it?',
      ]);
      expect(skills.find((s) => s.name === 'example_tool')).toBeUndefined();
      const plannerSkill = skills.find((s) => s.id === 'weather_agent-planner');
      expect(plannerSkill).toEqual({
        id: 'weather_agent-planner',
        name: 'planning',
        description: 'Can think about the tasks to do and make plans',
        tags: ['llm', 'planning'],
      });
    });

    it('logs a warning and continues when building skills for one sub-agent fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const brokenSub = new LlmAgent({name: 'broken_sub'});
        vi.spyOn(brokenSub, 'canonicalTools').mockRejectedValue(
          new Error('tool failure'),
        );
        brokenSub.tools = [
          new FunctionTool({
            name: 't',
            description: 'd',
            execute: async () => 'ok',
          }),
        ];
        const healthySub = new CustomAgent('healthy_sub', 'Healthy sub-agent');
        const parent = new CustomAgent('parent', 'Parent', [
          brokenSub,
          healthySub,
        ]);

        const subSkills = await buildSubAgentSkills(parent);

        expect(subSkills).toHaveLength(1);
        expect(subSkills[0]?.id).toBe('healthy_sub_healthy_sub');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Failed to build skills for sub-agent broken_sub',
          ),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('skill security support', () => {
    const apiKeyScheme: SecurityScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'X-Api-Key',
    };

    it('applies defaultSkillSecurity and per-tool customMetadata security overrides end to end', async () => {
      const readTool = new FunctionTool({
        name: 'read_item',
        description: 'Read an item.',
        execute: async () => 'item',
      });
      const deleteTool = new FunctionTool({
        name: 'delete_item',
        description: 'Delete an item.',
        execute: async () => 'deleted',
        customMetadata: {security: [{oauth2: ['items.delete']}]},
      });
      const agent = new LlmAgent({
        name: 'inventory_agent',
        description: 'Manages inventory items.',
        model: 'gemini-flash-latest',
        tools: [readTool, deleteTool],
      });
      const defaultSecurity: SkillSecurity = [{oauth2: ['items.read']}];

      const card = await new AgentCardBuilder({
        agent,
        securitySchemes: {oauth2: apiKeyScheme},
        defaultSkillSecurity: defaultSecurity,
      }).build();

      const securityById = Object.fromEntries(
        card.skills.map((skill) => [skill.id, skill.security]),
      );
      expect(securityById).toEqual({
        'inventory_agent': defaultSecurity,
        'inventory_agent-read_item': defaultSecurity,
        'inventory_agent-delete_item': [{oauth2: ['items.delete']}],
      });
    });

    it('attaches defaultSkillSecurity to LlmAgent, planner, code-executor, orchestration, and sub-agent skills', async () => {
      const defaultSecurity: SkillSecurity = [{bearer: []}];
      const subAgent = new LlmAgent({
        name: 'sub_agent',
        description: 'Sub agent',
      });
      const parent = new LlmAgent({
        name: 'test_llm_agent',
        description: 'A test LLM agent',
        subAgents: [subAgent],
      });

      const llmSkills = await buildLlmAgentSkills(parent, defaultSecurity);
      expect(llmSkills).toHaveLength(1);
      expect(llmSkills[0]?.security).toEqual(defaultSecurity);

      const plannerSkill = buildPlannerSkill(parent, defaultSecurity);
      expect(plannerSkill.security).toEqual(defaultSecurity);

      const codeSkill = buildCodeExecutorSkill(parent, [{oauth2: ['execute']}]);
      expect(codeSkill.security).toEqual([{oauth2: ['execute']}]);

      const orchSkill = buildOrchestrationSkill(
        parent,
        'sequential_workflow',
        defaultSecurity,
      );
      expect(orchSkill?.security).toEqual(defaultSecurity);

      const subSkills = await buildSubAgentSkills(parent, defaultSecurity);
      expect(subSkills).toHaveLength(1);
      expect(subSkills[0]?.security).toEqual(defaultSecurity);
    });

    it('resolves tool security from customMetadata or falls back to defaultSkillSecurity', async () => {
      const defaultSecurity: SkillSecurity = [{apiKey: []}];
      const toolSecurity: SkillSecurity = [
        {oauth2: ['calendar.read', 'calendar.write']},
      ];

      const plainTool = new FunctionTool({
        name: 'my_tool',
        description: 'A test tool',
        execute: async () => 'ok',
      });
      const overriddenTool = new FunctionTool({
        name: 'calendar_tool',
        description: 'Calendar tool',
        execute: async () => 'ok',
        customMetadata: {security: toolSecurity},
      });
      const unrelatedMetaTool = new FunctionTool({
        name: 'other_tool',
        description: 'Other tool',
        execute: async () => 'ok',
        customMetadata: {otherKey: 'value'},
      });

      expect(getToolSecurity(plainTool, defaultSecurity)).toEqual(
        defaultSecurity,
      );
      expect(getToolSecurity(overriddenTool, defaultSecurity)).toEqual(
        toolSecurity,
      );
      expect(getToolSecurity(unrelatedMetaTool, defaultSecurity)).toEqual(
        defaultSecurity,
      );
      expect(getToolSecurity(plainTool)).toBeUndefined();

      const agentWithDefault = new LlmAgent({
        name: 'test_agent',
        tools: [plainTool, overriddenTool],
      });
      const skillsWithDefault = await buildToolSkills(
        agentWithDefault,
        defaultSecurity,
      );
      expect(skillsWithDefault.map((s) => s.security)).toEqual([
        defaultSecurity,
        toolSecurity,
      ]);

      const skillsWithoutDefault = await buildToolSkills(
        new LlmAgent({name: 'test_agent', tools: [plainTool]}),
      );
      expect(skillsWithoutDefault[0]?.security).toBeUndefined();
    });

    it('logs a warning and falls back to defaultSkillSecurity when tool security metadata is malformed', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const defaultSecurity: SkillSecurity = [{bearer: []}];
        const malformedTool = new FunctionTool({
          name: 'classified_tool',
          description: 'Classified tool',
          execute: async () => 'ok',
          customMetadata: {security: {classification: 'internal'}},
        });

        const result = getToolSecurity(malformedTool, defaultSecurity);

        expect(result).toEqual(defaultSecurity);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('classified_tool'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('validates skill security scheme references and warns on undeclared schemes', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        validateSkillSecurityReferences(
          [
            {
              id: 's1',
              name: 'skill1',
              description: 'test',
              tags: ['test'],
              security: [{oauth2: ['read']}],
            },
            {
              id: 's2',
              name: 'skill2',
              description: 'test',
              tags: ['test'],
            },
          ],
          {oauth2: apiKeyScheme},
        );
        expect(warnSpy).not.toHaveBeenCalled();

        validateSkillSecurityReferences(
          [
            {
              id: 's1',
              name: 'skill1',
              description: 'test',
              tags: ['test'],
              security: [{nonexistentScheme: ['read']}],
            },
          ],
          {oauth2: apiKeyScheme},
        );
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('nonexistentScheme');
        expect(warnSpy.mock.calls[0]?.[0]).toContain('not declared');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
