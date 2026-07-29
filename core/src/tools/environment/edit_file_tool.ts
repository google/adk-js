/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as fs from 'fs/promises';

import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {isFileNotFoundError, resolveAndValidatePath, toError} from './utils.js';

/**
 * Escapes every regular-expression metacharacter in `str` so that the result
 * matches the input as literal text. The JavaScript equivalent of Python's
 * `re.escape`.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface EditFileToolParams {
  workingDir: string;
}

/** The result of an {@link EditFileTool} call. */
export interface EditFileResult {
  /** `'ok'` when the edit was applied, `'error'` otherwise. */
  status: 'ok' | 'error';
  /** Confirmation of what was edited. Set when `status` is `'ok'`. */
  message?: string;
  /** Why the call failed. Always set when `status` is `'error'`. */
  error?: string;
}

/**
 * EditFileTool for performing surgical text replacements in existing files.
 */
@experimental
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

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<EditFileResult> {
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
    } catch (e) {
      return {status: 'error', error: toError(e).message};
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf8');
    } catch (e) {
      if (isFileNotFoundError(e)) {
        return {status: 'error', error: `File not found: ${pathArg}`};
      }
      return {status: 'error', error: toError(e).message};
    }

    // Newlines are not regex metacharacters, so they survive `escapeRegExp`
    // unchanged and can be relaxed here to match either line ending.
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

    // A function replacement is used so that `$&`, `` $` `` and `$1` occurring
    // in `new_string` are inserted literally instead of being expanded as
    // replacement patterns.
    const newContent = content.replace(pattern, () => newString);
    try {
      await fs.writeFile(fullPath, newContent, 'utf8');
      return {status: 'ok', message: `Edited ${pathArg}`};
    } catch (e) {
      return {status: 'error', error: toError(e).message};
    }
  }
}
