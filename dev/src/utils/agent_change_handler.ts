/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {BaseAgentLoader} from './base_agent_loader.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({
  label: 'AgentChangeEventHandler',
  colorize: {all: true},
});

const JS_AGENT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.mts',
  '.cts',
]);

const WATCHED_FILE_EXTENSIONS = new Set([
  ...JS_AGENT_EXTENSIONS,
  '.yaml',
  '.yml',
]);

/**
 * Loader contract for invalidating a cached agent by name when its source
 * files change.
 */
export interface CachingAgentLoader {
  removeAgentFromCache(agentName: string): void;
}

/**
 * Options for constructing an {@link AgentChangeEventHandler}.
 */
export interface AgentChangeEventHandlerOptions {
  agentLoader: BaseAgentLoader;
  runnersToClean: Set<string>;
  agentsDir: string;
}

function isCachingAgentLoader(
  loader: BaseAgentLoader,
): loader is BaseAgentLoader & CachingAgentLoader {
  return (
    'removeAgentFromCache' in loader &&
    typeof loader.removeAgentFromCache === 'function'
  );
}

function isWatchedAgentFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return WATCHED_FILE_EXTENSIONS.has(ext);
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isSingleAgentDirectory(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === 'root_agent.yaml' || entry.name === 'root_agent.yml') {
        return true;
      }
      const parsed = path.parse(entry.name);
      if (
        (parsed.name === 'agent' || parsed.name === 'app') &&
        JS_AGENT_EXTENSIONS.has(parsed.ext.toLowerCase())
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function hasIndexEntryFile(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const parsed = path.parse(entry.name);
      if (
        parsed.name === 'index' &&
        JS_AGENT_EXTENSIONS.has(parsed.ext.toLowerCase())
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function isIgnoredDirectorySegment(segment: string): boolean {
  return segment === 'node_modules' || segment.startsWith('.');
}

/**
 * Resolves the agent names affected by a modified file under `agentsDir`,
 * ignoring paths that traverse `node_modules` or dot-prefixed directories.
 *
 * Containment is checked lexically with `path.resolve` and `path.relative` and
 * does not follow symlinks.
 */
function resolveModifiedAgentNames(
  agentsDir: string,
  filePath: string,
  isSingleFileTarget: boolean,
): string[] {
  if (isSingleFileTarget) {
    const resolvedCandidate = path.resolve(path.dirname(agentsDir), filePath);
    return resolvedCandidate === agentsDir ? [path.parse(agentsDir).name] : [];
  }

  const resolvedPath = path.resolve(agentsDir, filePath);
  const relPath = path.relative(agentsDir, resolvedPath);
  if (
    !relPath ||
    relPath === '..' ||
    relPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relPath)
  ) {
    return [];
  }

  const segments = relPath.split(path.sep);
  if (segments.slice(0, -1).some(isIgnoredDirectorySegment)) {
    return [];
  }
  if (segments.length === 1) {
    return [path.parse(segments[0]).name];
  }

  const agentNames: string[] = [];
  let currentDir = path.dirname(resolvedPath);
  while (currentDir !== agentsDir && currentDir !== path.dirname(currentDir)) {
    if (isSingleAgentDirectory(currentDir)) {
      const relDir = path.relative(agentsDir, currentDir);
      agentNames.push(relDir.split(path.sep).join('.'));
    }
    currentDir = path.dirname(currentDir);
  }

  const topLevelName = segments[0];
  const topLevelDir = path.join(agentsDir, topLevelName);
  if (
    (hasIndexEntryFile(topLevelDir) || agentNames.length > 0) &&
    !agentNames.includes(topLevelName)
  ) {
    agentNames.push(topLevelName);
  }

  return agentNames;
}

/**
 * File-change handler that invalidates cached agents and marks affected
 * `AdkApiServer` runners for recreation when agent source or config files
 * change.
 */
export class AgentChangeEventHandler {
  readonly agentLoader: BaseAgentLoader;
  readonly runnersToClean: Set<string>;
  readonly agentsDir: string;
  private readonly isSingleFileTarget: boolean;

  constructor(options: AgentChangeEventHandlerOptions) {
    if (
      typeof options.agentsDir !== 'string' ||
      options.agentsDir.trim().length === 0
    ) {
      throw new Error('agentsDir must be a non-empty string.');
    }
    this.agentLoader = options.agentLoader;
    this.runnersToClean = options.runnersToClean;
    this.agentsDir = path.resolve(options.agentsDir);
    this.isSingleFileTarget = isRegularFile(this.agentsDir);
  }

  /**
   * Processes a modified file path (absolute or relative to {@link agentsDir}),
   * evicting matching cached agents and recording their names in
   * {@link runnersToClean}.
   */
  onModified(filePath: string | null | undefined): void {
    if (!filePath || !isWatchedAgentFile(filePath)) {
      return;
    }

    const agentNames = resolveModifiedAgentNames(
      this.agentsDir,
      filePath,
      this.isSingleFileTarget,
    );
    if (agentNames.length === 0) {
      return;
    }

    logger.debug(`Change detected in agents directory: ${filePath}`);
    for (const agentName of agentNames) {
      if (isCachingAgentLoader(this.agentLoader)) {
        this.agentLoader.removeAgentFromCache(agentName);
      }
      this.runnersToClean.add(agentName);
    }
  }

  /**
   * Returns a `node:fs` watch listener bound to {@link onModified}.
   */
  createWatchListener(): fs.WatchListener<string> {
    return (_event, filename) => {
      this.onModified(filename);
    };
  }
}
