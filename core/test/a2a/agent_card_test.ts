/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildAgentSkills, resolveAgentCard} from '../../src/a2a/agent_card.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

import {
  BaseAgent,
  BaseTool,
  BaseToolset,
  FunctionTool,
  getA2AAgentCard,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
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
      expect(modelSkill?.description).toContain('I am a helpful assistant'); // pronoun replacement test

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
  });

  describe('buildAgentSkills', () => {
    it('handles dynamic instructions safely', async () => {
      const mockProvider = vi
        .fn()
        .mockResolvedValue('You are dynamically created');
      const agent = new LlmAgent({
        name: 'dyn_agent',
        instruction: mockProvider,
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      expect(modelSkill?.description).toContain('I am dynamically created');
    });

    it('handles dynamic instruction failure safely', async () => {
      const mockProvider = vi.fn().mockRejectedValue(new Error('fail'));
      const agent = new LlmAgent({
        name: 'dyn_agent_fail',
        description: 'Fallback desc',
        instruction: mockProvider,
      });

      const skills = await buildAgentSkills(agent);
      const modelSkill = skills.find((s) => s.name === 'model');
      // If instruction fails, it falls back to empty, but still uses description
      expect(modelSkill?.description).toContain('Fallback desc');
    });

    it('handles global instructions', async () => {
      const properRoot = new LlmAgent({
        name: 'root',
        globalInstruction: 'You are global',
        subAgents: [
          new LlmAgent({
            name: 'sub',
            instruction: 'You are sub',
          }),
        ],
      });

      const properlyWiredSub = properRoot.subAgents[0] as LlmAgent;

      const skills = await buildAgentSkills(properlyWiredSub);
      const modelSkill = skills.find((s) => s.name === 'model');

      expect(modelSkill?.description).toContain('I am sub');
      expect(modelSkill?.description).toContain('I am global');
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
      fetchMock.mockResolvedValue(cardResponse());

      const card = await resolveAgentCard('http://10.0.0.5/');

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
  });
});
