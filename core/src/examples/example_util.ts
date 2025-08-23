/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, Part} from '@google/genai';

import {BaseExampleProvider} from './base_example_provider.js';
import {Example} from './example.js';

const EXAMPLES_INTRO =
    '<EXAMPLES>\nBegin few-shot\nThe following are examples of user queries and' +
    ' model responses using the available tools.\n\n';
const EXAMPLES_END = 'End few-shot\n<EXAMPLES>';
const EXAMPLE_START = 'EXAMPLE {}:\nBegin example\n';
const EXAMPLE_END = 'End example\n\n';
const USER_PREFIX = '[user]\n';
const MODEL_PREFIX = '[model]\n';
const FUNCTION_PREFIX = '```\n';
const FUNCTION_CALL_PREFIX = '```tool_code\n';
const FUNCTION_CALL_SUFFIX = '\n```\n';
const FUNCTION_RESPONSE_PREFIX = '```tool_outputs\n';
const FUNCTION_RESPONSE_SUFFIX = '\n```\n';

/**
 * Converts a list of examples to a string that can be used in a system
 * instruction.
 */
export function convertExamplesToText(
    examples: Example[], model?: string): string {
  let examplesStr = '';
  for (const [exampleNum, example] of examples.entries()) {
    let output =
        `${EXAMPLE_START.replace('{}', String(exampleNum + 1))}${USER_PREFIX}`;
    if (example.input?.parts) {
      output += example.input.parts.filter((part: Part) => part.text)
                    .map((part: Part) => part.text!)
                    .join('\n') +
          '\n';
    }

    const gemini2 = !model || model.includes('gemini-2');
    let previousRole: string|undefined;
    for (const content of example.output) {
      const role = content.role === 'model' ? MODEL_PREFIX : USER_PREFIX;
      if (role !== previousRole) {
        output += role;
      }
      previousRole = role;
      for (const part of content.parts || []) {
        if (part.functionCall) {
          const prefix = gemini2 ? FUNCTION_PREFIX : FUNCTION_CALL_PREFIX;
          const functionCall = part.functionCall as FunctionCall;
          const args: string[] = [];
          if (functionCall.args) {
            for (const [k, v] of Object.entries(functionCall.args)) {
              if (typeof v === 'string') {
                args.push(`${k}='${v}'`);
              } else {
                args.push(`${k}=${v}`);
              }
            }
          }
          const functionCallString = `${functionCall.name}(${args.join(', ')})`;
          output += `${prefix}${functionCallString}${FUNCTION_CALL_SUFFIX}`;
        } else if (part.functionResponse) {
          const prefix = gemini2 ? FUNCTION_PREFIX : FUNCTION_RESPONSE_PREFIX;
          output += `${prefix}${JSON.stringify(part.functionResponse)}${
              FUNCTION_RESPONSE_SUFFIX}`;
        } else if (part.text) {
          output += `${part.text}\n`;
        }
      }
    }

    output += EXAMPLE_END;
    examplesStr += output;
  }

  return `${EXAMPLES_INTRO}${examplesStr}${EXAMPLES_END}`;
}

export function buildExampleSi(
    examples: Example[]|BaseExampleProvider, query: string,
    model?: string): string {
  if (Array.isArray(examples)) {
    return convertExamplesToText(examples, model);
  }
  if (examples instanceof BaseExampleProvider) {
    return convertExamplesToText(examples.getExamples(query), model);
  }

  throw new Error('Invalid example configuration');
}
