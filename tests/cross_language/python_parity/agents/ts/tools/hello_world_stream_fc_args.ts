/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/tools/hello_world_stream_fc_args.
 *
 * The sample is about the request config, not the tools: function-call
 * arguments are streamed
 * (`toolConfig.functionCallingConfig.streamFunctionCallArguments`) and genai's
 * own automatic function calling is disabled so ADK stays in charge of the
 * loop. Both flags exist on the genai TS `GenerateContentConfig` and adk-js
 * spreads `generateContentConfig` straight into the request
 * (core/src/agents/processors/basic_llm_request_processor.ts:40).
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const concatNumberAndString = new FunctionTool({
  name: 'concat_number_and_string',
  description: 'Concatenate a number and a string.',
  parameters: z.object({
    num: z.number().describe('The number to concatenate.'),
    s: z.string().describe('The string to concatenate.'),
  }),
  // Python's `str(num)` renders a float as "42.0"; JS `String(42)` renders
  // "42". That is a language difference in the sample body, not a framework
  // one, and shows up only in the tool response text.
  execute: ({num, s}) => `${num}: ${s}`,
});

const writeDocument = new FunctionTool({
  name: 'write_document',
  description: 'Write a document.',
  parameters: z.object({
    document: z.string(),
  }),
  execute: () => ({status: 'ok'}),
});

export const rootAgent = new LlmAgent({
  model: PARITY_MODEL,
  name: 'hello_world_stream_fc_args',
  description: 'Demo agent showcasing streaming function call arguments.',
  instruction: `
      You are a helpful assistant.
      You can use the \`concat_number_and_string\` tool to concatenate a number and a string.
      You should always call the concat_number_and_string tool to concatenate a number and a string.
      You should never concatenate on your own.

      You can use the \`write_document\` tool to write a document.
      You should always call the write_document tool to write a document.
      You should never write a document on your own.
    `,
  tools: [concatNumberAndString, writeDocument],
  generateContentConfig: {
    automaticFunctionCalling: {
      disable: true,
    },
    toolConfig: {
      functionCallingConfig: {
        streamFunctionCallArguments: true,
      },
    },
  },
});
