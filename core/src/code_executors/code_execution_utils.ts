/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Content, Language, Outcome, Part} from '@google/genai';

import {deepClone} from '../utils/deep_clone.js';
import {base64Encode, isBase64Encoded} from '../utils/env_aware_utils.js';

/**
 * A structure that contains a file name and its content
 */
export interface File {
  /**
   * The name of the file with file extension(e.g., ' file.csv')
   * */
  name: string;

  /**
   * The base64 - encoded bytes of the file content.
   * */
  content: string;

  /**
   * The mime type of the file (e.g., ' image / png')
   * */
  mimeType: string;
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
   * The input files available to the code.
   * */
  inputFiles: File[];

  /**
   * The execution ID for the stateful code execution.
   * */
  executionId?: string;
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
  groups?: {prefix?: string; codeStr?: string;};
  index?: number;
  length?: number;
}

/**
 * Extracts the first code block from the content and truncate everything after
 * it.
 *
 * @param content The mutable content to extract the code from.
 * @param codeBlockDelimiters The list of the enclosing delimiters to identify
 *     the code blocks.
 * @return The first code block if found, otherwise None.
 */
export function extractCodeAndTruncateContent(
    content: Content,
    codeBlockDelimiters: Array<[string, string]>,
    ): string {
  if (!content.parts?.length) {
    return '';
  }

  // Extract the code from the executable code parts if there're no associated
  // code execution result parts.
  for (let i = 0; i < content.parts.length; i++) {
    const part = content.parts[i];
    if (part.executableCode &&
        (i === content.parts.length - 1 ||
         !content.parts[i + 1].codeExecutionResult)) {
      content.parts = content.parts.slice(0, i + 1);
      return part.executableCode.code!;
    }
  }

  // Extract the code from the text parts.
  const textParts = content.parts.filter((part) => part.text);
  if (!textParts.length) {
    return '';
  }

  const firstTextPart = deepClone(textParts[0])!;
  const responseText = textParts.map((part) => part.text!).join('\n');

  // Find the first code block.
  const leadingDelimiterPattern =
      codeBlockDelimiters.map((d) => d[0]).join('|');
  const trailingDelimiterPattern =
      codeBlockDelimiters.map((d) => d[1]).join('|');
  const match =
      new RegExp(
          `?<prefix>.*?)(${leadingDelimiterPattern})(?<codeStr>.*?)(${
              trailingDelimiterPattern})(?<suffix>.*?)$`,
          's').exec(responseText) as unknown as CodeGroupMatch |
      null;

  const {prefix, codeStr} = match?.groups || {};

  if (!codeStr) {
    return '';
  }

  content.parts = [];

  if (prefix) {
    firstTextPart.text = prefix;
    content.parts.push(firstTextPart);
  }
  content.parts.push(buildExecutableCodePart(codeStr));

  return codeStr;
}

/**
 * Builds an executable code part with code string.
 *
 * @param code The code string.
 * @return The constructed executable code part.
 */
export function buildExecutableCodePart(code: string): Part {
  return {
    text: code,
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
      text: codeExecutionResult.stderr,
      codeExecutionResult: {
        outcome: Outcome.OUTCOME_FAILED,
      },
    };
  }

  const finalResult = [];
  if (codeExecutionResult.stdout || !codeExecutionResult.outputFiles) {
    finalResult.push(`Code execution result:\n${codeExecutionResult.stdout}\n`);
  }
  if (codeExecutionResult.outputFiles) {
    finalResult.push(
        `Saved artifacts:\n` +
        codeExecutionResult.outputFiles.map(f => f.name).join(', '));
  }

  return {
    text: finalResult.join('\n\n'),
    codeExecutionResult: {
      outcome: Outcome.OUTCOME_OK,
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
      text: codeBlockDelimiter[0] + lastPart.executableCode.code +
          codeBlockDelimiter[1],
    };
  } else if (content.parts.length == 1 && lastPart.codeExecutionResult) {
    content.parts[content.parts.length - 1] = {
      text: executionResultDelimiters[0] + lastPart.codeExecutionResult.output +
          executionResultDelimiters[1],
    };
    content.role = 'user'
  }
}
