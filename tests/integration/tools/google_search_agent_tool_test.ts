/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createGoogleSearchAgent,
  FunctionTool,
  GoogleSearchAgentTool,
  LlmAgent,
  State,
} from '@google/adk';
import {FinishReason, GroundingMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

/**
 * End-to-end test with no mocking of the code under test: a real `Runner`,
 * `LlmAgent`, `AgentTool`, and `GoogleSearchAgentTool` run together. Only the
 * network boundary (the Gemini model) is a canned in-process double, so no
 * credentials or live calls are required.
 */
describe('GoogleSearchAgentTool (e2e)', () => {
  it('runs alongside another tool and surfaces grounding metadata', async () => {
    const groundingMetadata: GroundingMetadata = {
      webSearchQueries: ['capital of France'],
    };

    // The isolated search sub-agent answers with grounding metadata, exactly
    // as the built-in google_search tool would.
    const subAgentResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [{text: 'Paris is the capital of France.'}],
              role: 'model',
            },
            groundingMetadata,
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    // The parent agent first calls the search tool, then a sibling tool that
    // reads the propagated grounding metadata, then answers.
    const rootResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'google_search_agent',
                    args: {request: 'capital of France'},
                    id: 'call-search',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'capture_grounding',
                    args: {},
                    id: 'call-capture',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [{text: 'The capital of France is Paris.'}],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    let capturedGrounding: unknown;
    const captureTool = new FunctionTool({
      name: 'capture_grounding',
      description: 'Records grounding metadata surfaced by the search tool.',
      execute: (_input: string, toolContext?: Context) => {
        capturedGrounding = toolContext?.state.get(
          `${State.TEMP_PREFIX}_adk_grounding_metadata`,
        );
        return 'captured';
      },
    });

    const searchAgent = createGoogleSearchAgent(
      new GeminiWithMockResponses(subAgentResponses),
    );
    const searchTool = new GoogleSearchAgentTool(searchAgent);

    const rootAgent = new LlmAgent({
      name: 'root_agent',
      model: new GeminiWithMockResponses(rootResponses),
      description: 'A root agent that can search and use other tools.',
      instruction:
        'Use google_search_agent to search, then capture_grounding, then answer.',
      // The whole point of the wrapper: google_search used ALONGSIDE another
      // tool without the "cannot be combined with other tools" restriction.
      tools: [searchTool, captureTool],
    });

    const runner = await createRunner(rootAgent);

    const texts: string[] = [];
    for await (const event of runner.run('What is the capital of France?')) {
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          texts.push(part.text);
        }
      }
    }

    // Composition worked end-to-end: no mixing restriction error, and the
    // parent produced its final grounded answer.
    expect(texts.join(' ')).toContain('Paris');
    // Grounding metadata produced by the sub-agent's search was propagated to
    // the parent invocation and readable by a sibling tool.
    expect(capturedGrounding).toEqual(groundingMetadata);
  });
});
