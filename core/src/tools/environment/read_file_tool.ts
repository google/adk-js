/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as fs from 'fs/promises';

import {experimental} from '../../utils/experimental.js';
import {resolveAndValidatePath} from '../../utils/file_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {MAX_OUTPUT_CHARS} from './constants.js';
import {isFileNotFoundError, toError, truncate} from './utils.js';

export interface ReadFileToolParams {
  workingDir: string;
  maxOutputChars?: number;
}

/** The result of a {@link ReadFileTool} call. */
export interface ReadFileResult {
  /** `'ok'` when the file was read, `'error'` otherwise. */
  status: 'ok' | 'error';
  /** The selected lines, each prefixed with its 1-based line number. */
  content?: string;
  /** Total number of lines in the file, when only part of it was returned. */
  total_lines?: number;
  /** Why the call failed. Always set when `status` is `'error'`. */
  error?: string;
}

/**
 * Whether a raw tool argument is usable as a 1-based line number.
 *
 * `Number.isInteger` already rejects `NaN` and every non-number, so that is the
 * only check needed.
 */
function isValidLineNumber(val: unknown): val is number {
  return Number.isInteger(val);
}

/**
 * ReadFileTool for reading file contents in the environment.
 */
@experimental
export class ReadFileTool extends BaseTool {
  private readonly workingDir: string;
  private readonly maxOutputChars: number;

  constructor(params: ReadFileToolParams) {
    super({
      name: 'ReadFile',
      description:
        'Read the contents of a file in the environment. Returns the file content with line numbers.',
    });
    this.workingDir = params.workingDir;
    this.maxOutputChars = params.maxOutputChars ?? MAX_OUTPUT_CHARS;
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
            description: 'Path of the file to read within the environment.',
          },
          start_line: {
            type: Type.INTEGER,
            description:
              'First line to return (1-based, inclusive). Defaults to 1.',
          },
          end_line: {
            type: Type.INTEGER,
            description:
              'Last line to return (1-based, inclusive). Defaults to end of file.',
          },
        },
        required: ['path'],
      },
    };
  }

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<ReadFileResult> {
    const pathArg = args['path'];
    if (typeof pathArg !== 'string' || !pathArg) {
      return {status: 'error', error: '`path` is required.'};
    }

    const startLineRaw = args['start_line'];
    const endLineRaw = args['end_line'];

    for (const [name, val] of Object.entries({
      start_line: startLineRaw,
      end_line: endLineRaw,
    })) {
      if (val !== undefined && val !== null && !isValidLineNumber(val)) {
        return {
          status: 'error',
          error: `\`${name}\` must be an integer if provided.`,
        };
      }
    }

    const startLine = isValidLineNumber(startLineRaw)
      ? startLineRaw
      : undefined;
    const endLine = isValidLineNumber(endLineRaw) ? endLineRaw : undefined;

    let fullPath: string;
    try {
      fullPath = resolveAndValidatePath(this.workingDir, pathArg);
    } catch (e) {
      return {status: 'error', error: toError(e).message};
    }

    try {
      const data = await fs.readFile(fullPath, 'utf8');
      const lines = data.split(/(?<=\r?\n)/);
      const total = lines.length;

      const start = Math.max(1, startLine || 1);
      const end = Math.min(total, endLine || total);

      if (start > total) {
        return {
          status: 'error',
          error: `\`start_line\` ${start} exceeds file length (${total} lines).`,
          total_lines: total,
        };
      }
      if (start > end) {
        return {
          status: 'error',
          error: `\`start_line\` (${start}) is after \`end_line\` (${end}).`,
          total_lines: total,
        };
      }

      const selectedLines = lines.slice(start - 1, end);
      const numbered = selectedLines
        .map((line, i) => `${String(start + i).padStart(6, ' ')}\t${line}`)
        .join('');

      const result: ReadFileResult = {
        status: 'ok',
        content: truncate(numbered, this.maxOutputChars),
      };

      if (start > 1 || end < total) {
        result.total_lines = total;
      }
      return result;
    } catch (e) {
      if (isFileNotFoundError(e)) {
        return {status: 'error', error: `File not found: ${pathArg}`};
      }
      return {status: 'error', error: toError(e).message};
    }
  }
}
