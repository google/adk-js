/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {describe, expect, it, vi} from 'vitest';
import {buildAgentSkills, resolveAgentCard} from '../../src/a2a/agent_card.js';
import {node} from '../../src/workflow/node.js';
import {Workflow} from '../../src/workflow/workflow.js';

import type {AgentCard} from '@a2a-js/sdk';
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
    ): Promise<T> {
      const server = http.createServer((req, res) => {
        const port = (server.address() as AddressInfo).port;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(cardFactory(port)));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const port = (server.address() as AddressInfo).port;
        return await fn(`http://127.0.0.1:${port}`);
      } finally {
        server.close();
      }
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
});
