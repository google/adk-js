/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec, spawn, SpawnOptions} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {AgentLoader} from '../../utils/agent_loader.js';
import {
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../../utils/file_utils.js';

export const execAsync = promisify(exec);
export const spawnAsync = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    child.on('error', reject);
  });
};

export const REQUIRED_NPM_PACKAGES = ['@google/adk'];

export async function copyAgentFiles(
  agentLoader: AgentLoader,
  targetPath: string,
): Promise<void> {
  const agentNames = await agentLoader.listAgents();

  for (const agentName of agentNames) {
    const agentFile = await agentLoader.getAgentFile(agentName);
    const fileName = path.parse(agentFile.getFilePath()).base;

    await fs.cp(agentFile.getFilePath(), path.join(targetPath, fileName));
  }
}

export async function createPackageJson(
  sourceFolder: string,
  targetFolder: string,
) {
  const packageJsonPath = await tryToFindFileRecursively(
    sourceFolder,
    'package.json',
    3,
  );
  const packageJson = await loadFileData<{
    dependencies: Record<string, string>;
  }>(packageJsonPath);
  if (!packageJson || !packageJson.dependencies) {
    throw new Error(
      `No dependencies found in package.json: ${packageJsonPath}`,
    );
  }
  for (const requiredDep of REQUIRED_NPM_PACKAGES) {
    if (!(requiredDep in packageJson.dependencies)) {
      throw new Error(
        `Package "${requiredDep}" is required but not found in package.json: ${
          packageJsonPath
        }`,
      );
    }
  }

  const targetPackageJsonPath = path.join(targetFolder, 'package.json');

  await Promise.all([
    fs.mkdir(path.join(targetFolder, 'node_modules')),
    saveToFile(path.join(targetFolder, 'package-lock.json'), ''),
    saveToFile(targetPackageJsonPath, {
      dependencies: packageJson.dependencies,
    }),
  ]);
}

export async function resolveDefaultFromGcloudConfig(
  property: string,
): Promise<string | undefined> {
  const {stdout} = await execAsync('gcloud config get-value ' + property);
  return stdout.trim();
}
