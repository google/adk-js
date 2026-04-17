/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {File} from '../code_executors/code_execution_utils.js';

/**
 * Creates files with the given paths in the current working directory.
 * @param files The files to materialize.
 */
export async function materializeFiles(files: File[], dir = process.cwd()) {
  const resolvedBaseDir = path.resolve(dir);
  for (const file of files) {
    const fullPath = path.resolve(dir, file.name);

    if (!fullPath.startsWith(resolvedBaseDir)) {
      throw new Error(
        `Path traversal detected: ${file.name} resolves outside of ${dir}`,
      );
    }

    await fs.mkdir(path.dirname(fullPath), {recursive: true});
    await fs.writeFile(
      fullPath,
      Buffer.from(file.content, file.contentEncoding),
    );
  }
}
