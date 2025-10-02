/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseAgent} from '@google/adk';
import esbuild from 'esbuild';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const DEFAULT_AGENT_CONFIG_FILENAME = 'agent_loader_config.json';

interface AgentNameToFileConfig {
  [key: string]: string;
}

/**
 * Wrapper class which loads file that contains base agent (support both .js and
 * .ts) and has a dispose function to cleanup the comliped artifact after file
 * usage.
 */
export class AgentFile {
  private cleanupFilePath: string|undefined;
  private disposed = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<BaseAgent> {
    let filePath = this.filePath;
    if (filePath.endsWith('.ts')) {
      const compiledFilePath = filePath.replace('.ts', '.cjs');

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node10.4',
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        bundle: true,
      });

      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const jsModule = await import(filePath);

    if (jsModule && jsModule.rootAgent) {
      return jsModule.rootAgent;
    }

    throw new Error(`Failed to load agent ${filePath}: No rootAgent found`);
  }

  async[Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.cleanupFilePath) {
      this.disposed = true;
      return fsPromises.unlink(this.cleanupFilePath);
    }
  }
}

/**
 * Loads agents from a JSON file. The JSON file is expected to be a map from
 * agent name to the path of the file containing the agent's code.
 *
 * User needs to define agent_loader_config.json file in the folder where they
 * want to run the CLI. The file should be a simple JSON object, having next
 * structure:
 * {
 *   "agent1": "agents/agent1.js",
 *   "agent2": "agents/agent2.ts"
 * }
 *
 * The key is the name of the agent, and value is the path to the file with
 * the agent code. The agent file path is relative to the folder where the
 * config file is. It could be any nesting level for the agent file and it
 * supports both .js and .ts files. Ts files will be compiled to .cjs files on
 * the fly and compiled target will be removed after the usage.
 */
export class AgentLoader {
  private readonly agentsLoaderConfig: AgentNameToFileConfig;
  private readonly agentsLoaderConfigFilePath: string;

  constructor(
      agentsLoaderConfigFilePath?: string,
  ) {
    this.agentsLoaderConfigFilePath = agentsLoaderConfigFilePath ||
        path.join(process.cwd(), DEFAULT_AGENT_CONFIG_FILENAME);
    this.agentsLoaderConfig = this.loadAgentsConfig();
  }

  private loadAgentsConfig(): AgentNameToFileConfig {
    try {
      const agentsConfig = JSON.parse(fs.readFileSync(
                               this.agentsLoaderConfigFilePath, 'utf8')) as
          AgentNameToFileConfig;
      return agentsConfig;
    } catch (e: unknown) {
      throw new Error(`${
          DEFAULT_AGENT_CONFIG_FILENAME} was not found or is not a valid JSON file. Please check if the file exists and is valid.`);
    }
  }

  getAgentPath(agentName: string): string {
    const agentPath = this.agentsLoaderConfig[agentName];

    if (!agentPath) {
      throw new Error(`File path is not defined for ${agentName} in ${
          DEFAULT_AGENT_CONFIG_FILENAME}`);
    }

    return path.join(process.cwd(), agentPath);
  }

  getAgentFile(agentName: string): AgentFile {
    return new AgentFile(this.getAgentPath(agentName));
  }

  async listAgents(): Promise<string[]> {
    return Object.keys(this.agentsLoaderConfig).sort();
  }
}
