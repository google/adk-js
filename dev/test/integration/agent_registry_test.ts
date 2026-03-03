/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  FunctionTool,
  LlmAgent,
  MCPToolset,
  SingleAgentCallback,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {AgentRegistry} from '../../src/integration/agent_registry.js';
import {YamlAgentConfig} from '../../src/integration/agent_types.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';

describe('AgentRegistry', () => {
  let integrationRegistry: IntegrationRegistry;
  let agentRegistry: AgentRegistry;

  beforeEach(() => {
    integrationRegistry = new IntegrationRegistry();
    agentRegistry = new AgentRegistry(integrationRegistry);
  });

  it('should register and retrieve an agent', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'test_model',
      description: 'test description',
      instruction: 'test instruction',
      beforeAgentCallback: [],
      afterAgentCallback: [],
    });

    agentRegistry.registerAgent('test_agent', agent);
    const retrieved = agentRegistry.getAgent('test_agent');

    expect(retrieved).toBe(agent);
    expect(agentRegistry.getAgent('non_existent')).toBeUndefined();
  });

  it('should register an agent from config', () => {
    const config = {
      name: 'config_agent',
      model: 'config_model',
      description: 'config description',
      instruction: 'config instruction',
      agentClass: 'LlmAgent',
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('config_agent', config);
    const retrieved = agentRegistry.getAgent('config_agent');

    expect(retrieved).toBeDefined();
    expect(retrieved).toBeInstanceOf(LlmAgent);
    if (retrieved) {
      expect(retrieved.name).toBe('config_agent');
    }
  });

  it('should register an agent from config with callbacks', () => {
    const beforeCallback: SingleAgentCallback = async () => undefined;
    const afterCallback: SingleAgentCallback = async () => undefined;

    integrationRegistry.registerBeforeAgentCallback(
      'before_cb',
      beforeCallback,
    );
    integrationRegistry.registerAfterAgentCallback('after_cb', afterCallback);

    const config = {
      name: 'callback_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      beforeAgentCallbacks: [{name: 'before_cb'}],
      afterAgentCallbacks: [{name: 'after_cb'}],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('callback_agent', config);
    const retrieved = agentRegistry.getAgent('callback_agent');

    expect(retrieved).toBeDefined();
  });

  it('should throw error if before callback is missing', () => {
    const config = {
      name: 'bad_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      beforeAgentCallbacks: [{name: 'missing_cb'}],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('bad_agent', config);
    expect(() => agentRegistry.getAgent('bad_agent')).toThrow(
      'BeforeAgentCallback missing_cb not found in registry',
    );
  });

  it('should throw error if after callback is missing', () => {
    const config = {
      name: 'bad_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      afterAgentCallbacks: [{name: 'missing_cb'}],
    } as unknown as YamlAgentConfig;
    agentRegistry.registerAgentConfig('bad_agent', config);
    expect(() => agentRegistry.getAgent('bad_agent')).toThrow(
      'AfterAgentCallback missing_cb not found in registry',
    );
  });

  it('should throw error if subagent is missing', () => {
    const config = {
      name: 'bad_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      subAgents: [{configPath: 'missing_subagent'}],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('bad_agent', config);
    expect(() => agentRegistry.getAgent('bad_agent')).toThrow(
      'SubAgent missing_subagent not found in registry (referenced by bad_agent)',
    );
  });

  it('should throw error if tool is missing', () => {
    const config = {
      name: 'bad_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [{name: 'missing_tool'}],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('bad_agent', config);
    expect(() => agentRegistry.getAgent('bad_agent')).toThrow(
      'Tool missing_tool not found in registry',
    );
  });

  it('should instantiate AgentTool', () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
    });
    agentRegistry.registerAgent('sub_agent_path', subAgent);

    const config = {
      name: 'parent_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [
        {
          name: 'AgentTool',
          args: {agent: {configPath: 'sub_agent_path'}},
        },
      ],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('parent_agent', config);
    const retrieved = agentRegistry.getAgent('parent_agent') as LlmAgent;

    expect(retrieved).toBeDefined();
    expect(retrieved.tools[0]).toBeInstanceOf(AgentTool);
  });

  it('should throw error if AgentTool references missing agent', () => {
    const config = {
      name: 'bad_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [
        {
          name: 'AgentTool',
          args: {agent: {configPath: 'missing_agent'}},
        },
      ],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('bad_agent', config);
    expect(() => agentRegistry.getAgent('bad_agent')).toThrow(
      'Agent missing_agent not found in registry (referenced by AgentTool in bad_agent)',
    );
  });

  it('should instantiate MCPToolset', () => {
    const config = {
      name: 'mcp_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [
        {
          name: 'McpToolset',
          args: {
            stdioConnectionParams: {
              command: 'node',
              args: ['server.js'],
            },
          },
        },
      ],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('mcp_agent', config);
    const retrieved = agentRegistry.getAgent('mcp_agent') as LlmAgent;

    expect(retrieved).toBeDefined();
    expect(retrieved.tools[0]).toBeInstanceOf(MCPToolset);
  });

  it('should handle LongRunningFunctionTool', () => {
    const tool = new FunctionTool({
      name: 'test_tool',
      description: 'desc',
      execute: async () => ({}),
    });
    integrationRegistry.registerTool('test_tool', tool);

    const config = {
      name: 'lr_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [
        {
          name: 'LongRunningFunctionTool',
          args: {func: 'test_tool'},
        },
      ],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('lr_agent', config);
    const retrieved = agentRegistry.getAgent('lr_agent') as LlmAgent;

    expect(retrieved).toBeDefined();
    expect(retrieved.tools[0]).toBe(tool);
  });

  it('should skip built-in tools', () => {
    const config = {
      name: 'builtin_agent',
      model: 'model',
      description: 'desc',
      instruction: 'inst',
      agentClass: 'LlmAgent',
      tools: [{name: 'exit_loop'}],
    } as unknown as YamlAgentConfig;

    agentRegistry.registerAgentConfig('builtin_agent', config);
    const retrieved = agentRegistry.getAgent('builtin_agent') as LlmAgent;

    expect(retrieved).toBeDefined();
    expect(retrieved.tools.length).toBe(0);
  });
});
