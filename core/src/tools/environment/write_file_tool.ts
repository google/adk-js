/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as fs from 'fs/promises';

import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {resolveAndValidatePath} from './utils.js';

export interface WriteFileToolParams {
  workingDir: string;
}

/**
 * WriteFileTool for creating or overwriting files in the environment.
 */
export class WriteFileTool extends BaseTool {
  private readonly workingDir: string;

  constructor(params: WriteFileToolParams) {
    super({
      name: 'WriteFile',
      description:
        'Create or overwrite a file in the environment. Use for new files or full rewrites. For small changes to existing files, prefer EditFile.',
    });
    this.workingDir = params.workingDir;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Path to the file within the environment.',
          },
          content: {
            type: Type.STRING,
            description: 'The full file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const pathArg = args['path'];
    const content = args['content'];

    if (typeof pathArg !== 'string' || !pathArg) {
      return {status: 'error', error: '`path` is required.'};
    }
    if (typeof content !== 'string') {
      return {status: 'error', error: '`content` must be a string.'};
    }

    let fullPath: string;
    try {
      fullPath = resolveAndValidatePath(this.workingDir, pathArg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return {status: 'error', error: String(e.message)};
    }

    try {
      await fs.writeFile(fullPath, content, 'utf8');
      return {status: 'ok', message: `Wrote ${pathArg}`};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return {status: 'error', error: String(e.message)};
    }
  }
}
