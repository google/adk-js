/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseAgent} from '@google/adk';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_AGENT_CONFIG_FILENAME = 'agent_loader_config.json';

interface AgentNameToFileConfig {
  [key: string]: string;
}

/**
 * Loads agents from a JSON file. The JSON file is expected to be a map from
 * agent name to the path of the file containing the agent's code.
 */
export class AgentLoader {
  private readonly agentsCache: Record<string, BaseAgent> = {};
  private readonly agentsLoaderConfig: AgentNameToFileConfig;
  private readonly agentsLoaderConfigFilePath: string;

  constructor(
      agentsLoaderConfigFilePath?: string,
  ) {
    this.agentsLoaderConfigFilePath = agentsLoaderConfigFilePath ||
        path.join(__dirname, '../../', DEFAULT_AGENT_CONFIG_FILENAME);
    this.agentsLoaderConfig = this.loadAgentsConfig();
  }

  private loadAgentsConfig(): AgentNameToFileConfig {
    try {
      const agentsConfig = JSON.parse(fs.readFileSync(
                               this.agentsLoaderConfigFilePath, 'utf8')) as
          AgentNameToFileConfig;
      return agentsConfig;
    } catch (e: unknown) {
      throw new Error(
          `Failed to load agents config. Please check if the file exists and is valid.`);
    }
  }

  async loadAgent(agentName: string): Promise<BaseAgent|undefined> {
    if (this.agentsCache[agentName]) {
      return this.agentsCache[agentName];
    }

    const agentPath = this.agentsLoaderConfig[agentName];
    if (!agentPath) {
      throw new Error(`Failed to load agent ${
          agentName} No agent config found for ${agentName}`);
    }

    const filePath =
        path.join(path.dirname(this.agentsLoaderConfigFilePath), agentPath);
    const jsModule = await import(filePath);

    if (jsModule && jsModule.rootAgent &&
        jsModule.rootAgent instanceof BaseAgent) {
      return this.agentsCache[agentName] = jsModule.rootAgent;
    }

    throw new Error(`Failed to load agent ${agentName}: No rootAgent found`);
  }

  async listAgents(): Promise<string[]> {
    return Object.keys(this.agentsLoaderConfig).sort();
  }
}
