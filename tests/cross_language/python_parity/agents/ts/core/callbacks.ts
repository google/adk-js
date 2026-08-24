/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/core/callbacks.
 *
 * Ported as literally as the two APIs allow: same tool name, same parameter
 * name, same short-circuit texts. Divergence in the transcript should come
 * from the runtimes, not from the agent definition.
 *
 * The callbacks take a single named-parameter object in TS
 * (`{context, request}`) where Python takes positional arguments
 * (`callback_context, llm_request`); the semantics — return a value to
 * short-circuit, return nothing to proceed — are the same.
 */
import type {LlmResponse} from '@google/adk';
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: '',
  parameters: z.object({
    city: z.string(),
  }),
  execute: ({city}) => `The weather in ${city} is sunny.`,
});

export const rootAgent = new LlmAgent({
  name: 'callback_demo_agent',
  model: PARITY_MODEL,
  tools: [getWeather],
  beforeToolCallback: ({args}) => {
    // Intercept tool calls for London and return a mocked response
    if (args['city'] === 'London') {
      return {
        result: 'Weather in London is always rainy (intercepted by callback).',
      };
    }
    return undefined;
  },
  beforeModelCallback: ({request}) => {
    // Short-circuit if the user simply says "Hi"
    const lastContent = request.contents?.at(-1);
    const lastPart = lastContent?.parts?.at(-1);
    if (lastPart?.text && lastPart.text.trim().toLowerCase() === 'hi') {
      return {
        content: {
          role: 'model',
          parts: [{text: 'Hello from before_model callback!'}],
        },
      } satisfies LlmResponse;
    }
    return undefined;
  },
  afterModelCallback: ({response}) => {
    if (response.usageMetadata) {
      const usage = response.usageMetadata;
      const usageText =
        '\n\nafter_model_callback: [Token Usage:' +
        ` Input=${usage.promptTokenCount},` +
        ` Output=${usage.candidatesTokenCount}]`;

      if (!response.content || !response.content.parts) {
        response.content = {role: 'model', parts: []};
      }

      response.content.parts!.push({text: usageText});
      console.log(response.content);
    }

    return response;
  },
});
