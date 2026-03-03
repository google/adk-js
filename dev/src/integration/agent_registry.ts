/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  FunctionTool,
  LlmAgent,
  LoopAgent,
  MCPToolset,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import * as path from 'node:path';
import {
  AgentToolArgs,
  LongRunningFunctionToolArgs,
  McpToolsetArgs,
  YamlAgentConfig,
} from './agent_types.js';
import {IntegrationRegistry} from './integration_registry.js';

const BUILTIN_TOOLS = [
  'exit_loop',
  'google_search',
  'url_context',
  'google_maps_grounding',
];

export class AgentRegistry {
  private agents = new Map<string, BaseAgent>();
  private configs = new Map<string, YamlAgentConfig>();
  private instantiating = new Set<string>();
  private integrationRegistry: IntegrationRegistry;

  constructor(integrationRegistry: IntegrationRegistry) {
    this.integrationRegistry = integrationRegistry;
  }

  registerAgent(name: string, agent: BaseAgent) {
    this.agents.set(name, agent);
  }

  getAgent(name: string): BaseAgent | undefined {
    if (this.agents.has(name)) {
      return this.agents.get(name);
    }
    if (this.configs.has(name)) {
      return this.instantiateAgent(name, this.configs.get(name)!);
    }
    return undefined;
  }

  // Returns the root agent based on the last directory name.
  // if there are somehow more than one root agent in a directory, an arbitrary one is returned
  getRootAgentByShortName(shortName: string): BaseAgent | undefined {
    for (const [name, config] of this.configs) {
      if (
        path.basename(path.dirname(name)) === shortName &&
        config.isRootAgent
      ) {
        return this.getAgent(name);
      }
    }

    return undefined;
  }

  registerAgentConfig(name: string, config: YamlAgentConfig) {
    this.configs.set(name, config);
  }

  private findToolOrThrow(name: string): FunctionTool<undefined> {
    const tool = this.integrationRegistry.getTool(name);
    if (!tool) {
      console.log('Tool not found in registry', name);
      throw new Error(`Tool ${name} not found in registry`);
    }
    return tool;
  }

  private instantiateAgent(name: string, config: YamlAgentConfig): BaseAgent {
    console.log(
      'Instantiating',
      name,
      'of class',
      config.agentClass ?? 'LlmAgent',
    );

    if (this.instantiating.has(name)) {
      throw new Error(`Circular dependency detected for agent ${name}`);
    }
    this.instantiating.add(name);

    try {
      const beforeAgentCallbacks = config.beforeAgentCallbacks?.map(
        (callbackInfo) => {
          const callback = this.integrationRegistry.getBeforeAgentCallback(
            callbackInfo.name,
          );
          if (!callback) {
            throw new Error(
              `BeforeAgentCallback ${callbackInfo.name} not found in registry`,
            );
          }
          return callback;
        },
      );

      const afterAgentCallbacks = config.afterAgentCallbacks?.map(
        (callbackInfo) => {
          const callback = this.integrationRegistry.getAfterAgentCallback(
            callbackInfo.name,
          );
          if (!callback) {
            throw new Error(
              `AfterAgentCallback ${callbackInfo.name} not found in registry`,
            );
          }
          return callback;
        },
      );

      const subAgents = config.subAgents?.map((ref) => {
        const subAgent = this.getAgent(ref.configPath);
        if (!subAgent) {
          throw new Error(
            `SubAgent ${ref.configPath} not found in registry (referenced by ${name})`,
          );
        }
        return subAgent;
      });

      const tools = config.tools
        ?.map((toolConfig) => {
          // Built in tools are skipped
          if (BUILTIN_TOOLS.includes(toolConfig.name)) {
            return undefined;
          }

          if (toolConfig.name == 'LongRunningFunctionTool') {
            const args = toolConfig.args as LongRunningFunctionToolArgs;
            const subTool = this.findToolOrThrow(args!.func);
            return subTool;
          }

          if (toolConfig.name === 'AgentTool') {
            const args = toolConfig.args as AgentToolArgs;
            const subAgent = this.getAgent(args.agent.configPath);
            if (!subAgent) {
              throw new Error(
                `Agent ${args.agent.configPath} not found in registry (referenced by AgentTool in ${name})`,
              );
            }
            return new AgentTool({agent: subAgent});
          }

          if (toolConfig.name === 'McpToolset') {
            const args = toolConfig.args as McpToolsetArgs;

            // Ensure the type of the connection params is correct
            if (args.stdioConnectionParams.type !== 'StdioConnectionParams') {
              args.stdioConnectionParams.type = 'StdioConnectionParams';
            }

            const toolset = new MCPToolset(
              args.stdioConnectionParams!,
              args.toolFilter,
            );
            return toolset;
          }

          return this.findToolOrThrow(toolConfig.name);
        })
        // remove entries for built-in tools
        .filter((tool) => tool !== undefined);

      const options = {
        name: config.name,
        model: config.model,
        description: config.description,
        instruction: config.instruction,
        beforeAgentCallback: beforeAgentCallbacks ?? [],
        afterAgentCallback: afterAgentCallbacks ?? [],
        subAgents: subAgents ?? [],
        tools: tools ?? [],
        disallowTransferToParent: config.disallowTransferToParent === 'true',
        disallowTransferToPeers: config.disallowTransferToPeers === 'true',
        temperature: config.generateContentConfig?.temperature,
      };

      let agent: BaseAgent;
      switch (config.agentClass) {
        case 'LoopAgent':
          agent = new LoopAgent({
            ...options,
            maxIterations: config.maxIterations
              ? parseInt(config.maxIterations, 10)
              : undefined,
          });
          break;
        case 'ParallelAgent':
          agent = new ParallelAgent(options);
          break;
        case 'SequentialAgent':
          agent = new SequentialAgent(options);
          break;
        case 'LlmAgent':
        default:
          agent = new LlmAgent(options);
          break;
      }

      this.registerAgent(name, agent);
      return agent;
    } finally {
      this.instantiating.delete(name);
    }
  }

  summary(): string {
    return `${this.configs.size} configs, ${this.agents.size} instantiated agents`;
  }
}
