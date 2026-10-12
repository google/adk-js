/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Content, Language, Outcome, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';

import {base64Encode, isBase64Encoded} from '../utils/env_aware_utils.js';

export enum FileContentEncoding {
  UTF8 = 'utf-8',
  BASE64 = 'base64',
}

/**
 * A structure that contains a file name and its content
 */
export interface File {
  /**
   * The name of the file with file extension(e.g., ' file.csv')
   * */
  name: string;

  /**
   * The encoded bytes of the file content.
   * */
  content: string;

  /**
   * The encoding of the file content.
   */
  contentEncoding?: FileContentEncoding;

  /**
   * The mime type of the file (e.g., ' image / png')
   * */
  mimeType: string;
}

/**
 * The language of the code to execute.
 */
export enum CodeExecutionLanguage {
  UNSPECIFIED = 'unspecified',
  PYTHON = 'python',
  JAVASCRIPT = 'javascript',
  TYPESCRIPT = 'typescript',
  // Linux, WSL, macOS
  SHELL = 'shell',
  // Windows only
  POWERSHELL = 'powershell',
  WINDOWS_CMD = 'cmd',
}

/**
 * A structure that contains the input of code execution.
 * */
export interface CodeExecutionInput {
  /**
   * The code to execute.
   * */
  code: string;

  /**
   * The language of the code to execute.
   */
  language: CodeExecutionLanguage;

  /**
   * The input files available to the code.
   * */
  inputFiles: File[];

  /**
   * The execution ID for the stateful code execution.
   * */
  executionId?: string;

  /**
   * Optional arguments to pass to the executed code/script.
   */
  args?: string[] | Record<string, string | number | boolean>;
}

/**
 * A structure that contains the result of code execution.
 * */
export interface CodeExecutionResult {
  /**
   * The standard output of the code execution.
   * */
  stdout: string;

  /**
   * The standard error of the code execution.
   * */
  stderr: string;

  /**
   * The output files from the code execution.
   * */
  outputFiles: File[];
}

/**
 * Gets the file content as a base64-encoded bytes.
 *
 * @param data The file content bytes.
 * @return The file content as a base64-encoded bytes.
 */
export function getEncodedFileContent(data: string): string {
  return isBase64Encoded(data) ? data : base64Encode(data);
}

// Type to be used for regex matching of code blocks.
interface CodeGroupMatch {
  groups?: {prefix?: string; leading?: string; codeStr?: string};
  index?: number;
  length?: number;
}

/**
 * The language of each known fence tag. `tool_code` is the fence that the
 * adk-python samples tell the model to use for Python.
 */
const FENCE_TAG_LANGUAGE_MAP: Record<string, CodeExecutionLanguage> = {
  tool_code: CodeExecutionLanguage.PYTHON,
  python: CodeExecutionLanguage.PYTHON,
  py: CodeExecutionLanguage.PYTHON,
  javascript: CodeExecutionLanguage.JAVASCRIPT,
  js: CodeExecutionLanguage.JAVASCRIPT,
  typescript: CodeExecutionLanguage.TYPESCRIPT,
  ts: CodeExecutionLanguage.TYPESCRIPT,
  bash: CodeExecutionLanguage.SHELL,
  sh: CodeExecutionLanguage.SHELL,
  shell: CodeExecutionLanguage.SHELL,
};

/**
 * The result for a response that has no code block.
 */
const NO_CODE_BLOCK: Readonly<ExtractedCodeBlock> = Object.freeze({
  code: '',
  language: CodeExecutionLanguage.UNSPECIFIED,
});

/**
 * Gets the language of the code in a block from the block's leading delimiter.
 *
 * @param leadingDelimiter The leading delimiter of a code block, for example
 *     '```javascript\n'.
 * @return The language that the fence tag names, or
 *     `CodeExecutionLanguage.UNSPECIFIED` for a tag that is not known. The
 *     executor decides what to do with an unspecified language.
 */
export function getCodeBlockLanguage(
  leadingDelimiter: string,
): CodeExecutionLanguage {
  const tag = leadingDelimiter.trim().replace(/^`+/, '').toLowerCase();
  return FENCE_TAG_LANGUAGE_MAP[tag] ?? CodeExecutionLanguage.UNSPECIFIED;
}

/**
 * A code block extracted from a model response.
 */
export interface ExtractedCodeBlock {
  /**
   * The code in the block, or an empty string if there is no block.
   */
  code: string;

  /**
   * The language of the code, from the fence that matched it.
   */
  language: CodeExecutionLanguage;
}

/**
 * Extracts the first code block from the content and truncate everything after
 * it.
 *
 * @param content The mutable content to extract the code from.
 * @param codeBlockDelimiters The list of the enclosing delimiters to identify
 *     the code blocks.
 * @return The first code block if found, otherwise an empty string.
 */
export function extractCodeAndTruncateContent(
  content: Content,
  codeBlockDelimiters: Array<[string, string]>,
): string {
  return extractCodeBlockAndTruncateContent(content, codeBlockDelimiters).code;
}

/**
 * Extracts the first code block and its language from the content, and
 * truncates everything after it.
 *
 * An `executableCode` part holds Python. A code block in text has the
 * language of the fence tag in its leading delimiter: see
 * {@link getCodeBlockLanguage}.
 *
 * @param content The mutable content to extract the code from.
 * @param codeBlockDelimiters The list of the enclosing delimiters to identify
 *     the code blocks.
 * @return The first code block and its language. With no code block, the
 *     code is an empty string and the language is
 *     `CodeExecutionLanguage.UNSPECIFIED`.
 */
export function extractCodeBlockAndTruncateContent(
  content: Content,
  codeBlockDelimiters: Array<[string, string]>,
): ExtractedCodeBlock {
  if (!content.parts?.length) {
    return {...NO_CODE_BLOCK};
  }

  // Extract the code from the executable code parts if there're no associated
  // code execution result parts.
  for (let i = 0; i < content.parts.length; i++) {
    const part = content.parts[i];
    if (
      part.executableCode &&
      (i === content.parts.length - 1 ||
        !content.parts[i + 1].codeExecutionResult)
    ) {
      content.parts = content.parts.slice(0, i + 1);
      return {
        code: part.executableCode.code || '',
        language: CodeExecutionLanguage.PYTHON,
      };
    }
  }

  // Extract the code from the text parts.
  const textParts = content.parts.filter((part) => part.text);
  if (!textParts.length) {
    return {...NO_CODE_BLOCK};
  }

  const firstTextPart = cloneDeep(textParts[0])!;
  const responseText = textParts.map((part) => part.text!).join('\n');

  // Find the first code block.
  const leadingDelimiterPattern = codeBlockDelimiters
    .map((d) => d[0])
    .join('|');
  const trailingDelimiterPattern = codeBlockDelimiters
    .map((d) => d[1])
    .join('|');
  const match = new RegExp(
    `(?<prefix>.*?)(?<leading>${leadingDelimiterPattern})(?<codeStr>.*?)(${trailingDelimiterPattern})(?<suffix>.*?)$`,
    's',
  ).exec(responseText) as unknown as CodeGroupMatch | null;

  const {prefix, leading, codeStr} = match?.groups || {};

  if (!codeStr) {
    return {...NO_CODE_BLOCK};
  }

  content.parts = [];

  if (prefix) {
    firstTextPart.text = prefix;
    content.parts.push(firstTextPart);
  }
  content.parts.push(buildExecutableCodePart(codeStr));

  return {code: codeStr, language: getCodeBlockLanguage(leading ?? '')};
}

/**
 * Builds an executable code part with code string.
 *
 * @param code The code string.
 * @return The constructed executable code part.
 */
export function buildExecutableCodePart(code: string): Part {
  return {
    executableCode: {
      code,
      language: Language.PYTHON,
    },
  };
}

/**
 * Builds the code execution result part from the code execution result.
 *
 * @param codeExecutionResult The code execution result.
 * @return The code execution result part.
 */
export function buildCodeExecutionResultPart(
  codeExecutionResult: CodeExecutionResult,
): Part {
  if (codeExecutionResult.stderr) {
    return {
      codeExecutionResult: {
        outcome: Outcome.OUTCOME_FAILED,
        output: codeExecutionResult.stderr,
      },
    };
  }

  const finalResult = [];
  if (codeExecutionResult.stdout || !codeExecutionResult.outputFiles.length) {
    finalResult.push(`Code execution result:\n${codeExecutionResult.stdout}\n`);
  }
  if (codeExecutionResult.outputFiles.length) {
    finalResult.push(
      `Saved artifacts:\n` +
        codeExecutionResult.outputFiles.map((f) => `\`${f.name}\``).join(','),
    );
  }

  return {
    codeExecutionResult: {
      outcome: Outcome.OUTCOME_OK,
      output: finalResult.join('\n\n'),
    },
  };
}

/**
 * Converts the code execution parts to text parts in a Content.
 *
 * @param content The mutable content to convert the code execution parts to
 *     text parts.
 * @param codeBlockDelimiter The delimiter to format the code block.
 * @param executionResultDelimiters The delimiter to format the code execution
 *     result.
 * @return The converted content.
 */
export function convertCodeExecutionParts(
  content: Content,
  codeBlockDelimiter: [string, string],
  executionResultDelimiters: [string, string],
) {
  if (!content.parts?.length) {
    return;
  }

  const lastPart = content.parts[content.parts.length - 1];

  if (lastPart.executableCode) {
    content.parts[content.parts.length - 1] = {
      text:
        codeBlockDelimiter[0] +
        (lastPart.executableCode.code || '') +
        codeBlockDelimiter[1],
    };
  } else if (content.parts.length == 1 && lastPart.codeExecutionResult) {
    const output = lastPart.codeExecutionResult.output;
    // No output means no delimiters either, just an empty text part.
    const text =
      output == null
        ? ''
        : executionResultDelimiters[0] + output + executionResultDelimiters[1];
    content.parts[content.parts.length - 1] = {text};
    content.role = 'user';
  }
}
