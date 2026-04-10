/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import camelcaseKeys from 'camelcase-keys';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {AgentToolArgs, YamlAgentConfig} from '../integration/agent_types.js';

/**
 * batchLoadYamlAgentConfig will recursively search the directory given
 * and load all of the YAML files into in-memory config.
 */
export async function batchLoadYamlAgentConfig(
  directory: string,
): Promise<Map<string, YamlAgentConfig>> {
  console.log('Loading agents from ', directory);
  const files = fg.stream('**/*.{yaml,yml}', {
    cwd: directory,
    absolute: true,
  });
  const agents = new Map<string, YamlAgentConfig>();

  for await (const file of files) {
    const filePath = (file as string).replaceAll('\\', '/');
    const content = await fs.readFile(filePath, 'utf-8');
    const agentConfig = camelcaseKeys(yaml.load(content) as YamlAgentConfig, {
      deep: true,
    }) as YamlAgentConfig;

    // Allow retrieval of root agents based on filename
    agentConfig.isRootAgent =
      path.posix.basename(filePath) === 'root_agent.yaml';

    // Make agent names unique by including relative file path from given root dir
    const normalizedDir = directory.replaceAll('\\', '/');
    const relativePath = path.posix.relative(normalizedDir, filePath);
    const parsedPath = path.posix.parse(relativePath);
    const name = path.posix.join(parsedPath.dir, parsedPath.name);
    agents.set(name, agentConfig);
  }

  // Update subagent to correctly point to the sibling file names
  for (const [name, agent] of agents) {
    // Rewrite subagents if used
    if (agent.subAgents) {
      for (const subAgent of agent.subAgents) {
        subAgent.configPath = rewriteConfigPath(name, subAgent.configPath);
      }
    }

    // Also rewrite subagent names if used as a tool
    if (agent.tools) {
      for (const tool of agent.tools) {
        if (tool.name !== 'AgentTool') {
          continue;
        }

        const args = tool.args as AgentToolArgs;
        if (args.agent?.configPath) {
          args.agent.configPath = rewriteConfigPath(
            name,
            args.agent.configPath,
          );
        }
      }
    }
  }

  return agents;
}

function rewriteConfigPath(
  baseAgentName: string,
  relativeConfigPath: string,
): string {
  const normalizedRelativeConfigPath = relativeConfigPath.replaceAll('\\', '/');
  const dir = path.posix.dirname(baseAgentName);
  const agentPath = path.posix.join(dir, normalizedRelativeConfigPath);
  const parsed = path.posix.parse(agentPath);
  return path.posix.join(parsed.dir, parsed.name);
}
