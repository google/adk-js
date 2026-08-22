/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Reports whether resolvedPath is resolvedBaseDir itself, or a path nested
 * inside it.
 *
 * A plain `resolvedPath.startsWith(resolvedBaseDir)` check is a path-separator-
 * unaware prefix match: it also accepts sibling directories whose name merely
 * starts with the same string, e.g. base dir `/tmp/agent` wrongly "contains"
 * `/tmp/agent-evil/x`. Requiring the trailing separator (or exact equality)
 * closes that gap.
 */
function isInsideDir(resolvedPath: string, resolvedBaseDir: string): boolean {
  return (
    resolvedPath === resolvedBaseDir ||
    resolvedPath.startsWith(resolvedBaseDir + path.sep)
  );
}

/**
 * Writes `files` into `dir`, refusing any entry that resolves outside of it.
 *
 * `dir` is deliberately required and has no default: file names typically
 * originate from a code executor's output (i.e. from model- or skill-controlled
 * content), so the destination must be a dedicated directory chosen by the
 * caller. Defaulting to `process.cwd()` would let such content drop files into
 * the host application's working directory.
 *
 * @param files The files to materialize.
 * @param dir The directory to materialize the files into.
 */
export async function materializeFiles(
  files: File[],
  dir: string,
): Promise<File[]> {
  const resolvedBaseDir = path.resolve(dir);
  const createdFiles: File[] = [];
  for (const file of files) {
    const fullPath = path.resolve(dir, file.name);

    if (!isInsideDir(fullPath, resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    const ext = path.extname(fullPath);
    const dirName = path.dirname(fullPath);
    const base = path.basename(fullPath, ext);
    const originalDir = path.dirname(file.name);

    await fs.mkdir(dirName, {recursive: true});

    // Write with `wx` (O_CREAT | O_EXCL): it never overwrites and never follows
    // a symlink at the final component, so it is both the collision check and
    // the write in one atomic step. On a collision — a real file, a file that
    // appeared in a race with a sibling call, or a (possibly dangling) symlink
    // the `fs.access` probe could not see — it rejects with EEXIST; we then
    // advance to a suffixed name and retry, rather than aborting. Mirrors
    // adk-python's version-reservation retry (`FileExistsError` -> bump).
    let finalPath = fullPath;
    let counter = 2;
    const buffer = Buffer.from(file.content, file.contentEncoding);
    while (true) {
      if (!isInsideDir(finalPath, resolvedBaseDir)) {
        throw new Error(
          `Path traversal detected: ${file.name} resolves outside of ${dir}`,
        );
      }
      try {
        await fs.writeFile(finalPath, buffer, {flag: 'wx'});
        break;
      } catch (err) {
        if ((err as Error & {code?: string}).code !== 'EEXIST') {
          throw err;
        }
        // Name taken — advance to `${base}_${counter}${ext}` and try again.
        const newName = `${base}_${counter}${ext}`;
        finalPath = path.join(dirName, newName);
        file.name =
          originalDir === '.' ? newName : path.join(originalDir, newName);
        counter++;
      }
    }

    createdFiles.push({
      ...file,
      name: path.relative(dir, finalPath),
    });
  }

  return createdFiles;
}

export const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  'pdf': 'application/pdf',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'csv': 'text/csv',
  'json': 'application/json',
  'xml': 'application/xml',
  'sh': 'text/x-shellscript',
  'bash': 'text/x-shellscript',
  'py': 'text/x-python',
  'js': 'text/javascript',
  'cjs': 'text/javascript',
  'mjs': 'text/javascript',
  'ts': 'text/javascript',
  'cts': 'text/javascript',
  'mts': 'text/javascript',
};

export function guessMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  return EXTENSION_TO_MIME_TYPE[ext] || 'application/octet-stream';
}
