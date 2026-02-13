/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, isBaseAgent} from '@google/adk';
import esbuild from 'esbuild';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {shimPlugin} from 'esbuild-shim-plugin';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

import {getTempDir, isFile, isFileExists, loadFileData} from './file_utils.js';

/**
 * Supported file extensions for JavaScript and TypeScript.
 */
const JS_FILES_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'];

/**
 * Supported JS/TS file module types.
 */
export enum FileModuleType {
  CJS = 'cjs',
  ESM = 'esm',
}

/**
 * Map of file module types to their file extensions.
 */
const FILE_MODULE_TYPE_EXTENSION_MAP = {
  [FileModuleType.CJS]: '.cjs',
  [FileModuleType.ESM]: '.mjs',
};

/**
 * Metadata for a file.
 */
interface FileMetadata {
  path: string;
  name: string;
  ext?: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Error class for agent file loading.
 */
class AgentFileLoadingError extends Error {}

/**
 * Options for loading an agent file.
 */
export interface AgentFileOptions {
  compile?: boolean;
  bundle?: boolean;
  moduleType?: FileModuleType;
}

/**
 * Default options for loading an agent file.
 *
 * Compile and bundle only .ts files.
 */
const DEFAULT_AGENT_FILE_OPTIONS: AgentFileOptions = {
  compile: true,
  bundle: true,
};

/**
 * Wrapper class which loads file that contains base agent (support both .js and
 * .ts) and has a dispose function to cleanup the comliped artifact after file
 * usage.
 */
export class AgentFile {
  private cleanupFilePath: string | undefined;
  private disposed = false;
  private agent?: BaseAgent;

  constructor(
    private readonly filePath: string,
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {}

  async load(): Promise<BaseAgent> {
    if (this.agent) {
      return this.agent;
    }

    try {
      await fsPromises.stat(this.filePath);
    } catch (e) {
      if ((e as {code: string}).code === 'ENOENT') {
        throw new AgentFileLoadingError(
          `Agent file ${this.filePath} does not exists`,
        );
      }
    }

    let filePath = this.filePath;
    const shouldCompile = this.options.compile || this.options.bundle;

    if (shouldCompile) {
      const moduleType =
        this.options.moduleType || (await getFileModuleType(filePath));
      const parsedPath = path.parse(filePath);
      const compiledFilePath = path.join(
        getTempDir('adk_agent_loader'),
        parsedPath.name + FILE_MODULE_TYPE_EXTENSION_MAP[moduleType],
      );

      await esbuild.build({
        entryPoints: [filePath],
        outfile: compiledFilePath,
        target: 'node16',
        platform: 'node',
        format: moduleType,
        packages: 'bundle',
        bundle: this.options.bundle,
        minify: this.options.bundle,
        allowOverwrite: true,
        plugins: [shimPlugin()],
      });

      this.cleanupFilePath = compiledFilePath;
      filePath = compiledFilePath;
    }

    const jsModule = await import(pathToFileURL(filePath).href);

    if (jsModule) {
      if (isBaseAgent(jsModule.rootAgent)) {
        return (this.agent = jsModule.rootAgent);
      }

      if (isBaseAgent(jsModule.default)) {
        return (this.agent = jsModule.default);
      }

      const rootAgents = Object.values(jsModule).filter((exportValue) =>
        isBaseAgent(exportValue),
      ) as BaseAgent[];

      if (rootAgents.length > 1) {
        console.warn(
          `Multiple agents found in ${filePath}. Using the ${
            rootAgents[0].name
          } as a root agent.`,
        );
      }

      if (rootAgents.length > 0) {
        return (this.agent = rootAgents[0]);
      }
    }

    await this.dispose();
    throw new AgentFileLoadingError(
      `Failed to load agent ${
        filePath
      }: No @google/adk BaseAgent class instance found. Please check that file is not empty and it has export of @google/adk BaseAgent class (e.g. LlmAgent) instance.`,
    );
  }

  getFilePath(): string {
    if (!this.agent) {
      throw new Error('Agent is not loaded yet');
    }

    if (this.disposed) {
      throw new Error('Agent is disposed and can not be used');
    }

    return this.cleanupFilePath || this.filePath;
  }

  async [Symbol.asyncDispose](): Promise<void> {
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

  constructor(
    private readonly agentsDirPath: string = process.cwd(),
    private readonly options = DEFAULT_AGENT_FILE_OPTIONS,
  ) {
    // Do cleanups on exit
    const exitHandler = async ({
      exit,
      cleanup,
    }: {
      exit?: boolean;
      cleanup?: boolean;
    }) => {
      if (cleanup) {
        await this.disposeAll();
      }

      if (exit) {
        process.exit();
      }
    };

    process.on('exit', () => exitHandler({cleanup: true}));
    process.on('SIGINT', () => exitHandler({exit: true}));
    process.on('SIGUSR1', () => exitHandler({exit: true}));
    process.on('SIGUSR2', () => exitHandler({exit: true}));
    process.on('uncaughtException', () => exitHandler({exit: true}));
  }

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
      Object.values(this.preloadedAgents).map((f) => f.dispose()),
    );
  }

  async preloadAgents() {
    if (this.agentsAlreadyPreloaded) {
      return;
    }

    const files = (await isFile(this.agentsDirPath))
      ? [await getFileMetadata(this.agentsDirPath)]
      : await getDirFiles(this.agentsDirPath);

    await Promise.all(
      files.map(async (fileOrDir: FileMetadata) => {
        if (fileOrDir.isFile && isJsFile(fileOrDir.ext)) {
          return this.loadAgentFromFile(fileOrDir);
        }

        if (fileOrDir.isDirectory) {
          return this.loadAgentFromDirectory(fileOrDir);
        }
      }),
    );

    this.agentsAlreadyPreloaded = true;
    return;
  }

  private async loadAgentFromFile(file: FileMetadata): Promise<void> {
    try {
      const agentFile = new AgentFile(file.path, this.options);
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
    const possibleAgentJsFile = subFiles.find(
      (f) => f.isFile && f.name === 'agent' && isJsFile(f.ext),
    );

    if (!possibleAgentJsFile) {
      return;
    }

    try {
      const agentFile = new AgentFile(possibleAgentJsFile.path, this.options);
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
    files.map((filePath) => getFileMetadata(path.join(dir, filePath))),
  );
}

async function getFileMetadata(filePath: string): Promise<FileMetadata> {
  const fileStats = await fsPromises.stat(filePath);
  const isFile = fileStats.isFile();
  const baseName = path.basename(filePath);
  const ext = path.extname(filePath);

  return {
    path: filePath,
    name: isFile ? baseName.slice(0, baseName.length - ext.length) : baseName,
    ext: isFile ? path.extname(filePath) : undefined,
    isFile,
    isDirectory: fileStats.isDirectory(),
  };
}

async function getFileModuleType(filePath: string): Promise<FileModuleType> {
  const {ext} = path.parse(filePath);

  if (['.cjs', '.cts'].includes(ext)) {
    return FileModuleType.CJS;
  }
  if (['.mts', '.mjs'].includes(ext)) {
    return FileModuleType.ESM;
  }

  if (['.js', '.ts'].includes(ext)) {
    return getTypeFromPackageJson(path.dirname(filePath));
  }

  return FileModuleType.CJS;
}

async function getTypeFromPackageJson(dir: string): Promise<FileModuleType> {
  const packagePath = path.join(dir, 'package.json');

  if (await isFileExists(packagePath)) {
    try {
      const packageJson = (await loadFileData(packagePath)) as {
        type?: 'commonjs' | 'module';
      };

      return packageJson.type === 'module'
        ? FileModuleType.ESM
        : FileModuleType.CJS;
    } catch {
      return FileModuleType.CJS;
    }
  }

  const parentDir = path.dirname(dir);
  if (parentDir === dir) {
    return FileModuleType.CJS;
  }

  return getTypeFromPackageJson(parentDir);
}
