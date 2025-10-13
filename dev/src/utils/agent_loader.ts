/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {BaseAgent} from '@google/adk';
import esbuild from 'esbuild';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const JS_FILES_EXTENSIONST_TO_COMPILE = ['.ts', '.mts'];
const JS_FILES_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts'];

interface FileMetadata {
  path: string;
  name: string;
  ext?: string;
  isFile: boolean;
  isDirectory: boolean;
}

class AgentFileLoadingError extends Error {}

/**
 * Wrapper class which loads file that contains base agent (support both .js and
 * .ts) and has a dispose function to cleanup the comliped artifact after file
 * usage.
 */
export class AgentFile {
  private cleanupFilePath: string|undefined;
  private disposed = false;
  private agent?: BaseAgent;

  constructor(private readonly filePath: string) {}

  async load(): Promise<BaseAgent> {
    if (this.agent) {
      return this.agent;
    }

    try {
      await fsPromises.stat(this.filePath);
    } catch (e) {
      if ((e as {code: string}).code === 'ENOENT') {
        throw new AgentFileLoadingError(
            `Agent file ${this.filePath} does not exists`);
      }
    }

    let filePath = this.filePath;
    const fileExt = path.extname(filePath);

    if (JS_FILES_EXTENSIONST_TO_COMPILE.includes(fileExt)) {
      const compiledFilePath = filePath.replace(fileExt, '.cjs');

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

    if (jsModule && jsModule.rootAgent && jsModule.rootAgent) {
      return this.agent = jsModule.rootAgent;
    }

    this.dispose();
    throw new AgentFileLoadingError(
        `Failed to load agent ${filePath}: No rootAgent found`);
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
 * Loads all agents from a given directory.
 *
 * The directory structure should be:
 * - agents_dir/{agentName}.[js | ts | mjs | cjs]
 * - agents_dir/{agentName}/agent.[js | ts | mjs | cjs]
 *
 * Agent file should has export of the rootAgent as instance of BaseAgent (e.g
 * LlmAgent).
 */
export class AgentLoader {
  private agentsAlreadyPreloaded = false;
  private readonly preloadedAgents: Record<string, AgentFile> = {};

  constructor(private readonly agentsDirPath: string = process.cwd()) {}

  async listAgents(): Promise<string[]> {
    await this.preloadAgents();

    return Object.keys(this.preloadedAgents).sort();
  }

  async getAgentFile(agentName: string): Promise<AgentFile> {
    await this.preloadAgents();

    return this.preloadedAgents[agentName];
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
        Object.values(this.preloadedAgents).map(f => f.dispose()));
  }

  private async preloadAgents() {
    if (this.agentsAlreadyPreloaded) {
      return;
    }

    const files = await isFile(this.agentsDirPath) ?
        [await getFileMetadata(this.agentsDirPath)] :
        await getDirFiles(this.agentsDirPath);

    await Promise.all(files.map(async (fileOrDir: FileMetadata) => {
      if (fileOrDir.isFile && isJsFile(fileOrDir.ext)) {
        return this.loadAgentFromFile(fileOrDir);
      }

      if (fileOrDir.isDirectory) {
        return this.loadAgentFromDirectory(fileOrDir);
      }
    }));

    this.agentsAlreadyPreloaded = true;
    return;
  }

  private async loadAgentFromFile(file: FileMetadata): Promise<void> {
    try {
      const agentFile = new AgentFile(file.path);
      await agentFile.load();
      this.preloadedAgents[file.name] = agentFile;
    } catch (e) {
      if (e instanceof AgentFileLoadingError) {
        return;
      }
      throw e;
    }
  }

  private async loadAgentFromDirectory(dir: FileMetadata): Promise<void> {
    const subFiles = await getDirFiles(dir.path);
    const possibleAgentJsFile =
        subFiles.find(f => f.isFile && f.name === 'agent' && isJsFile(f.ext));

    if (!possibleAgentJsFile) {
      return;
    }

    try {
      const agentFile = new AgentFile(possibleAgentJsFile.path);
      await agentFile.load();
      this.preloadedAgents[dir.name] = agentFile;
    } catch (e) {
      if (e instanceof AgentFileLoadingError) {
        return;
      }
      throw e;
    }
  }
}

function isJsFile(fileExt?: string): boolean {
  return !!fileExt && JS_FILES_EXTENSIONS.includes(fileExt);
}

async function getDirFiles(dir: string): Promise<FileMetadata[]> {
  const files = await fsPromises.readdir(dir);

  return await Promise.all(
      files.map(filePath => getFileMetadata(path.join(dir, filePath))));
}

async function getFileMetadata(filePath: string): Promise<FileMetadata> {
  const fileStats = await fsPromises.stat(filePath);
  const isFile = fileStats.isFile();
  const baseName = path.basename(filePath)
  const ext = path.extname(filePath);

  return {
    path: filePath,
    name: isFile ? baseName.slice(0, baseName.length - ext.length) : baseName,
    ext: isFile ? path.extname(filePath) : undefined,
    isFile,
    isDirectory: fileStats.isDirectory(),
  };
}

/** Check if the given path is a file. */
async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.isFile();
  } catch (e: unknown) {
    return false;
  }
}