/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';
import {getMimeTypeAndEncoding} from './file_extension_utils.js';

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

    let finalPath = fullPath;
    let counter = 2;

    while (true) {
      try {
        await fs.access(finalPath);
        // File exists, try next name
        const newName = `${base}_${counter}${ext}`;
        finalPath = path.join(dirName, newName);
        // Update file.name to reflect the actual relative path
        const originalDir = path.dirname(file.name);
        file.name =
          originalDir === '.' ? newName : path.join(originalDir, newName);
        counter++;
      } catch {
        // File does not exist, safe to write
        break;
      }
    }

    if (!isInsideDir(finalPath, resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    await fs.mkdir(path.dirname(finalPath), {recursive: true});
    // `wx` opens with O_CREAT | O_EXCL, which fails rather than writing when
    // anything already exists at `finalPath`. That matters for two reasons
    // beyond the containment check above:
    //   - A dangling symlink inside `dir` is invisible to the `fs.access`
    //     collision probe (it reports the link's missing target), so a plain
    //     write would follow the link and land outside `dir`. O_EXCL refuses
    //     to follow a symlink at the final path component.
    //   - It closes the check-then-write race between that probe and this
    //     write, so a file created in between is never clobbered.
    await fs.writeFile(
      finalPath,
      Buffer.from(file.content, file.contentEncoding),
      {flag: 'wx'},
    );

    createdFiles.push({
      ...file,
      name: path.relative(dir, finalPath),
    });
  }

  return createdFiles;
}

/**
 * Guesses the MIME type of a file from its extension.
 * @param filePath A file name or path.
 * @returns The MIME type, or 'application/octet-stream' if the extension is
 *     unknown or absent.
 */
export function guessMimeType(filePath: string): string {
  return getMimeTypeAndEncoding(path.extname(filePath)).mimeType;
}
