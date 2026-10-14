/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {logger} from '../../utils/logger.js';

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
 * @param agentName The name or path of the agent.
 * @param agentParentFolder The parent directory containing the agent. Defaults to `'.'`.
 * @param filename The dotenv filename to search for. Defaults to `'.env'`.
 */
export function loadDotenvForAgent(
  agentName: string,
  agentParentFolder = '.',
  filename = '.env',
): void {
  let startingFolder = path.resolve(agentParentFolder, agentName);
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
