/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as fs from 'fs/promises';

import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {resolveAndValidatePath} from './utils.js';

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}

export interface EditFileToolParams {
  workingDir: string;
}

/**
 * EditFileTool for performing surgical text replacements in existing files.
 */
export class EditFileTool extends BaseTool {
  private readonly workingDir: string;

  constructor(params: EditFileToolParams) {
    super({
      name: 'EditFile',
      description:
        'Replace an exact substring in an existing file with new text. The old_string must appear exactly once in the file. To create new files, use the WriteFile tool.',
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
            description: 'Path of the file to edit within the environment.',
          },
          old_string: {
            type: Type.STRING,
            description:
              'The exact text to find and replace. Must not be empty.',
          },
          new_string: {
            type: Type.STRING,
            description: 'The replacement text.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const pathArg = args['path'];
    const oldString = args['old_string'];
    const newString = args['new_string'];

    if (typeof pathArg !== 'string' || !pathArg) {
      return {status: 'error', error: '`path` is required.'};
    }
    if (typeof oldString !== 'string' || !oldString) {
      return {
        status: 'error',
        error:
          '`old_string` cannot be empty. To create a new file, use the WriteFile tool.',
      };
    }
    if (typeof newString !== 'string') {
      return {status: 'error', error: '`new_string` must be a string.'};
    }

    let fullPath: string;
    try {
      fullPath = resolveAndValidatePath(this.workingDir, pathArg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return {status: 'error', error: String(e.message)};
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return {status: 'error', error: `File not found: ${pathArg}`};
      }
      return {status: 'error', error: String(e.message)};
    }

    const normalizedOld = oldString.replace(/\r\n/g, '\n');
    const patternStr = escapeRegExp(normalizedOld).replace(/\n/g, '\\r?\\n');
    const pattern = new RegExp(patternStr, 'g');

    const matches = [...content.matchAll(pattern)];
    const count = matches.length;

    if (count === 0) {
      return {
        status: 'error',
        error:
          '`old_string` not found in file. Read the file first to verify contents.',
      };
    }
    if (count > 1) {
      return {
        status: 'error',
        error: `\`old_string\` appears ${count} times. Provide more surrounding context to make it unique.`,
      };
    }

    const newContent = content.replace(pattern, newString);
    try {
      await fs.writeFile(fullPath, newContent, 'utf8');
      return {status: 'ok', message: `Edited ${pathArg}`};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return {status: 'error', error: String(e.message)};
    }
  }
}
