/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GoogleSearchTool} from '../../../core/src/tools/google_search_tool.js';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

describe('GoogleSearchAgentTool Integration', () => {
  it('automatically wraps GoogleSearchTool and executes search via sub-agent', async () => {
    const mockResponses: RawGenerateContentResponse[] = [
      // Turn 1: Parent agent decides to call search agent
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'google_search_agent',
                    args: {request: 'who is the current president of the US'},
                    id: 'call-1',
                  },
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      // Turn 2: Sub-agent calls model to do search (it uses GOOGLE_SEARCH tool)
      // We simulate that it returns a text response with grounding metadata
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'The current president is...'}],
            },
            finishReason: FinishReason.STOP,

            groundingMetadata: {
              webSearchQueries: ['who is the current president of the US'],
              groundingChunks: [
                {web: {uri: 'https://example.com', title: 'Presidents'}},
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          },
        ],
      },
      // Turn 3: Parent agent receives the result and gives final answer
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Based on search, the current president is...'}],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    const model = new GeminiWithMockResponses(mockResponses);

    class MockTool extends BaseTool {
      constructor() {
        super({name: 'mock_tool', description: 'Mock Tool'});
      }
      runAsync() {
        return Promise.resolve();
      }
    }

    const searchTool = new GoogleSearchTool({bypassMultiToolsLimit: true});
    const mockTool = new MockTool();

    const mainAgent = new LlmAgent({
      model: model,
      name: 'mainAgent',
      description: 'MainAgent',
      instruction: 'You are a helpful assistant.',
      tools: [searchTool, mockTool], // triggers automatic wrapping!
    });

    let capturedGroundingMetadata: unknown = undefined;
    class MockSessionService extends InMemorySessionService {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override async appendEvent(request: any): Promise<any> {
        if (request.event.actions?.stateDelta?.['temp:grounding_metadata']) {
          capturedGroundingMetadata =
            request.event.actions.stateDelta['temp:grounding_metadata'];
        }
        return super.appendEvent(request);
      }
    }
    const sessionService = new MockSessionService();
    const memoryService = new InMemoryMemoryService();

    await sessionService.createSession({
      appName: 'mainAgent',
      userId: 'TestUser',
      sessionId: '1',
    });

    const runner = new Runner({
      appName: 'mainAgent',
      agent: mainAgent,
      sessionService,
      memoryService,
    });

    const runOptions = {
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {
        role: 'user',
        parts: [{text: 'Who is the current president of the US?'}],
      },
    };

    const events = [];
    for await (const event of runner.runAsync(runOptions)) {
      console.log('Integration test event:', JSON.stringify(event));
      events.push(event);
    }

    // Verify that the sub-agent was called
    const functionCallEvents = events.filter((e) =>
      e.content?.parts?.some((p) => p.functionCall),
    );
    expect(functionCallEvents.length).toBe(1);
    expect(functionCallEvents[0].content.parts[0].functionCall.name).toBe(
      'google_search_agent',
    );

    // Verify grounding metadata was propagated
    expect(capturedGroundingMetadata).toBeDefined();
  });
});
