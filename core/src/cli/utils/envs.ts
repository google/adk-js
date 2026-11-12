/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {InputValidationError} from '../../errors/input_validation_error.js';
import {logger} from '../../utils/logger.js';

import {isStrictlyInside, validatePathSegment} from './path_validation.js';

/**
 * Walks up the directory tree starting from `folder` until `filename` is found,
 * or until the filesystem root is reached.
 *
 * @param folder The directory to start searching from.
 * @param filename The file name to look for. Defaults to `'.env'`.
 * @returns The absolute path to the found file, or `''` if not found.
 */
export function walkToRootUntilFound(
  folder: string,
  filename = '.env',
): string {
  const checkpath = path.join(folder, filename);
  if (fs.existsSync(checkpath) && fs.statSync(checkpath).isFile()) {
    return path.resolve(checkpath);
  }

  const parentFolder = path.dirname(folder);
  if (parentFolder === folder) {
    return '';
  }

  return walkToRootUntilFound(parentFolder, filename);
}

/**
 * Parses a `.env` file content string into key-value pairs and loads them into
 * `process.env`, overriding any existing values.
 */
function parseAndLoadDotenv(content: string): void {
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const stripped = trimmed.replace(/^export\s+/, '');
    const eqIndex = stripped.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = stripped.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }

    let value = stripped.slice(eqIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const commentIndex = value.search(/\s+#/);
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trimEnd();
      }
    }

    process.env[key] = value;
  }
}

/**
 * Walks up from the agent directory to the root directory and loads the first
 * `.env` file found into `process.env` with override semantics.
 *
 * When `agentParentFolder` is given, `agentName` must be a single path segment
 * that resolves inside it. When `agentParentFolder` is omitted, `agentName` may
 * be a path, but it must not be `.` or contain a `..` segment. These checks
 * are lexical: they do not follow symlinks.
 *
 * @param agentName The name of the agent, or a path to it when
 *     `agentParentFolder` is omitted.
 * @param agentParentFolder The directory that contains the agent. Optional.
 * @param filename The dotenv file name to search for. Must be a single path
 *     segment. Defaults to `'.env'`.
 * @throws {InputValidationError} If `agentName`, `agentParentFolder` or
 *     `filename` is invalid, or if `agentName` resolves outside
 *     `agentParentFolder`.
 */
export function loadDotenvForAgent(
  agentName: string,
  agentParentFolder?: string,
  filename = '.env',
): void {
  validatePathSegment(filename, 'filename');
  if (typeof agentName !== 'string' || !agentName) {
    throw new InputValidationError('agentName must not be empty.');
  }
  if (agentName.includes('\x00')) {
    throw new InputValidationError('agentName must not contain null bytes.');
  }

  let startingFolder: string;
  if (agentParentFolder !== undefined) {
    if (
      typeof agentParentFolder !== 'string' ||
      !agentParentFolder ||
      agentParentFolder.includes('\x00')
    ) {
      throw new InputValidationError(
        'agentParentFolder must be a valid non-empty path.',
      );
    }
    validatePathSegment(agentName, 'agentName');
    const baseDir = path.resolve(agentParentFolder);
    startingFolder = path.resolve(baseDir, agentName);
    if (!isStrictlyInside(baseDir, startingFolder)) {
      throw new InputValidationError(
        `agentName '${agentName}' resolves outside agentParentFolder.`,
      );
    }
  } else {
    if (agentName === '.' || agentName.split(/[\\/]+/).includes('..')) {
      throw new InputValidationError(
        `agentName '${agentName}' must not contain traversal segments.`,
      );
    }
    startingFolder = path.resolve('.', agentName);
  }

  if (fs.existsSync(startingFolder) && fs.statSync(startingFolder).isFile()) {
    startingFolder = path.dirname(startingFolder);
  }

  const dotenvFilePath = walkToRootUntilFound(startingFolder, filename);
  if (dotenvFilePath) {
    const content = fs.readFileSync(dotenvFilePath, 'utf-8');
    parseAndLoadDotenv(content);
    logger.info(
      `Loaded ${filename} file for ${agentName} at ${dotenvFilePath}`,
    );
  } else {
    logger.info(`No ${filename} file found for ${agentName}`);
  }
}
