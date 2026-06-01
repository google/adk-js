/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, Part} from '@google/genai';

import {
  BaseExampleProvider,
  isBaseExampleProvider,
} from './base_example_provider.js';
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
 *
 * When `model` is undefined or contains `"gemini-2"`, function calls and
 * responses are formatted with plain triple-backtick fences. For other model
 * names the legacy `tool_code` / `tool_outputs` fences are used instead.
 *
 * @param examples - The few-shot examples to convert.
 * @param model - Optional model name used to select the function-call fence
 *   style. Defaults to the gemini-2 style when omitted.
 * @returns A formatted string wrapped in `<EXAMPLES>…</EXAMPLES>` tags,
 *   suitable for inclusion in a system instruction.
 */
export function convertExamplesToText(
  examples: Example[],
  model?: string,
): string {
  let examplesStr = '';
  for (const [exampleNum, example] of examples.entries()) {
    let output = `${EXAMPLE_START.replace('{}', String(exampleNum + 1))}${USER_PREFIX}`;
    if (example.input?.parts) {
      output +=
        example.input.parts
          .filter((part: Part) => part.text)
          .map((part: Part) => part.text!)
          .join('\n') + '\n';
    }

    const gemini2 = !model || model.includes('gemini-2');
    let previousRole: string | undefined;
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
            FUNCTION_RESPONSE_SUFFIX
          }`;
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

/**
 * Builds the few-shot portion of a system instruction from a list of examples
 * or a {@link BaseExampleProvider}.
 *
 * @param examples - Either an array of {@link Example} objects or a
 *   {@link BaseExampleProvider} whose `getExamples` method is called with
 *   `query` to obtain the examples dynamically.
 * @param query - The user query passed to {@link BaseExampleProvider.getExamples}
 *   when `examples` is a provider. Ignored when `examples` is an array.
 * @param model - Optional model name forwarded to
 *   {@link convertExamplesToText} to select the function-call fence style.
 * @returns A formatted string ready to be appended to a system instruction.
 * @throws {Error} When `examples` is neither an array nor a
 *   {@link BaseExampleProvider}.
 */
export function buildExampleSi(
  examples: Example[] | BaseExampleProvider,
  query: string,
  model?: string,
): string {
  if (Array.isArray(examples)) {
    return convertExamplesToText(examples, model);
  }
  if (isBaseExampleProvider(examples)) {
    return convertExamplesToText(examples.getExamples(query), model);
  }

  throw new Error('Invalid example configuration');
}
