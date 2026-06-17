/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Candidate,
  FinishReason,
  FunctionCall,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  isEmptyContentPart,
  StreamingResponseAggregator,
} from '../../src/utils/streaming_utils.js';

// Mock generateClientFunctionCallId to return a fixed ID for testing
vi.mock('../../src/agents/functions.js', async () => {
  const actual = (await vi.importActual(
    '../../src/agents/functions.js',
  )) as typeof import('../../src/agents/functions.js');
  return {
    ...actual,
    generateClientFunctionCallId: () => 'mocked-fc-id',
  };
});

function createResponse(candidate: Candidate): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = [candidate];

  return response;
}

describe('StreamingResponseAggregator', () => {
  describe('Progressive Mode', () => {
    it('should aggregate text chunks', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response1 = createResponse({
        content: {parts: [{text: 'Hello '}]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {parts: [{text: 'World!'}]},
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response1)) {
        results.push(res);
      }
      for await (const res of aggregator.processResponse(response2)) {
        results.push(res);
      }

      expect(results.length).toBe(2);
      expect(results[0].partial).toBe(true);
      expect(results[1].partial).toBe(true);

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([{text: 'Hello World!'}]);
      expect(finalResponse?.partial).toBe(false);
    });

    it('should aggregate thought chunks', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response1 = createResponse({
        content: {parts: [{text: 'Thinking ', thought: true} as Part]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {parts: [{text: 'hard...', thought: true} as Part]},
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // Consume the stream to test it
      }

      for await (const _ of aggregator.processResponse(response2)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([
        {text: 'Thinking hard...', thought: true},
      ]);
    });

    it('should preserve order of mixed text and thought chunks', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response1 = createResponse({
        content: {parts: [{text: 'Thinking...', thought: true} as Part]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {parts: [{text: 'Final Answer'}]},
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // Consume the stream to test it
      }
      for await (const _ of aggregator.processResponse(response2)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([
        {text: 'Thinking...', thought: true},
        {text: 'Final Answer'},
      ]);
    });

    it('should aggregate streaming function calls', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                partialArgs: [
                  {jsonPath: '$.location', stringValue: 'San Fran'},
                ],
                willContinue: true,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                partialArgs: [{jsonPath: '$.location', stringValue: 'cisco'}],
                willContinue: false,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // Consume the stream to test it
      }
      for await (const _ of aggregator.processResponse(response2)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'get_weather',
            args: {location: 'San Francisco'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should handle non-streaming function calls', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'New York'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'get_weather',
            args: {location: 'New York'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });
  });

  describe('Non-Progressive Mode', () => {
    it('should aggregate text chunks in close', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Hello '}]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {parts: [{text: 'World!'}]},
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // Consume the stream to test it
      }
      for await (const _ of aggregator.processResponse(response2)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([{text: 'Hello World!'}]);
    });

    it('should separate thought and text chunks in close', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Thinking...', thought: true} as Part]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {parts: [{text: 'Final Answer'}]},
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // Consume the stream to test it
      }
      for await (const _ of aggregator.processResponse(response2)) {
        // Consume the stream to test it
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.content?.parts).toEqual([
        {text: 'Thinking...', thought: true},
        {text: 'Final Answer'},
      ]);
    });

    it('should yield partial text chunks as they arrive', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Hello '}]},
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response1)) {
        results.push(res);
      }

      expect(results.length).toBe(1);
      expect(results[0].partial).toBe(true);
      expect(results[0].content?.parts).toEqual([{text: 'Hello '}]);
    });

    it('should yield partial thought chunks as they arrive', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Thinking...', thought: true} as Part]},
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response1)) {
        results.push(res);
      }

      expect(results.length).toBe(1);
      expect(results[0].partial).toBe(true);
      expect(results[0].content?.parts).toEqual([
        {text: 'Thinking...', thought: true},
      ]);
    });

    it('should handle non-text chunks and flush accumulated text', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Some text '}]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response1)) {
        results.push(res);
      }
      for await (const res of aggregator.processResponse(response2)) {
        results.push(res);
      }

      expect(results.length).toBe(3);
      expect(results[0].partial).toBe(true);
      expect(results[0].content?.parts).toEqual([{text: 'Some text '}]);

      expect(results[1].partial).toBe(false);
      expect(results[1].content?.parts).toEqual([{text: 'Some text '}]);

      expect(results[2].content?.parts).toEqual([
        {
          functionCall: {
            name: 'get_weather',
            args: {location: 'San Francisco'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should preserve tool calls without replaying them from close', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response1 = createResponse({
        content: {parts: [{text: 'Let me help with that. '}]},
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'showForecastChart',
                args: {location: 'San Francisco'},
              },
            },
            {
              functionCall: {
                name: 'showQuickActions',
                args: {actions: ['Refresh', 'Share']},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response1)) {
        results.push(res);
      }
      for await (const res of aggregator.processResponse(response2)) {
        results.push(res);
      }

      expect(results.length).toBe(3);
      expect(results[1].content?.parts).toEqual([
        {text: 'Let me help with that. '},
      ]);
      expect(results[2].content?.parts).toEqual([
        {
          functionCall: {
            name: 'showForecastChart',
            args: {location: 'San Francisco'},
            id: 'mocked-fc-id',
          },
        },
        {
          functionCall: {
            name: 'showQuickActions',
            args: {actions: ['Refresh', 'Share']},
            id: 'mocked-fc-id',
          },
        },
      ]);

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeUndefined();
    });

    it('should split mixed text and tool-call chunks into saveable events', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const response = createResponse({
        content: {
          parts: [
            {text: 'Let me help with that. '},
            {
              functionCall: {
                name: 'showForecastChart',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response)) {
        results.push(res);
      }

      expect(results.length).toBe(2);
      expect(results[0].partial).toBe(false);
      expect(results[0].content?.parts).toEqual([
        {text: 'Let me help with that. '},
      ]);
      expect(results[1].partial).toBe(false);
      expect(results[1].content?.parts).toEqual([
        {
          functionCall: {
            name: 'showForecastChart',
            args: {location: 'San Francisco'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });
  });

  describe('JSONPath Plus Integration', () => {
    it('should support bracket notation in paths', async () => {
      const aggregator = new StreamingResponseAggregator(true);
      const response = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'complex_func',
                partialArgs: [
                  {jsonPath: "$['user']['name']", stringValue: 'Alice'},
                ],
                willContinue: false,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response)) {
        // just consume iterator
      }

      const finalResponse = aggregator.close();
      expect(finalResponse?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'complex_func',
            args: {user: {name: 'Alice'}},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should not pollute Object.prototype via a malicious jsonPath', async () => {
      const aggregator = new StreamingResponseAggregator(true);
      const response = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'evil_func',
                partialArgs: [
                  {jsonPath: '$.__proto__.polluted', stringValue: 'PWNED'},
                  {
                    jsonPath: '$.constructor.prototype.polluted2',
                    stringValue: 'PWNED',
                  },
                ],
                willContinue: false,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response)) {
        // just consume iterator
      }
      aggregator.close();

      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(({} as Record<string, unknown>)['polluted2']).toBeUndefined();
    });

    it('should handle deeply nested structures and mixed notation', async () => {
      const aggregator = new StreamingResponseAggregator(true);
      const response = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'nested_func',
                partialArgs: [
                  {jsonPath: "$.config['db'].port", numberValue: 5432},
                  {jsonPath: '$.config.db.host', stringValue: 'localhost'},
                  {jsonPath: "$.options['enableRetry']", boolValue: true},
                  {jsonPath: '$.cache', nullValue: true},
                ],
                willContinue: false,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response)) {
        // just consume iterator
      }

      const finalResponse = aggregator.close();
      expect(finalResponse?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'nested_func',
            args: {
              config: {
                db: {
                  port: 5432,
                  host: 'localhost',
                },
              },
              options: {
                enableRetry: true,
              },
              cache: null,
            },
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should accumulate string chunks across multiple partial updates at the same path', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'concat_func',
                partialArgs: [
                  {jsonPath: '$.message.text', stringValue: 'Hello '},
                ],
                willContinue: true,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const response2 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                partialArgs: [
                  {jsonPath: '$.message.text', stringValue: 'World!'},
                ],
                willContinue: false,
              } as unknown as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // just consume iterator
      }
      for await (const _ of aggregator.processResponse(response2)) {
        // just consume iterator
      }

      const finalResponse = aggregator.close();
      expect(finalResponse?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'concat_func',
            args: {
              message: {
                text: 'Hello World!',
              },
            },
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should yield final response when last chunk has no candidates (progressive mode)', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      // First chunk: function call with candidates
      const chunkWithCandidate = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {city: 'Seattle'},
              } as FunctionCall,
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      // Final chunk: no candidates (Gemini stream termination signal)
      const emptyChunk = new GenerateContentResponse();
      emptyChunk.candidates = [];

      for await (const _ of aggregator.processResponse(chunkWithCandidate)) {
        // consume
      }
      for await (const _ of aggregator.processResponse(emptyChunk)) {
        // consume
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.partial).toBe(false);
      expect(finalResponse?.content?.parts).toHaveLength(1);
      expect(finalResponse?.content?.parts?.[0]?.functionCall?.name).toBe(
        'get_weather',
      );
    });
  });

  describe('Non-Progressive Mode', () => {
    it('should return undefined from close() when no data accumulated and last chunk has no candidates', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      const emptyChunk = new GenerateContentResponse();
      emptyChunk.candidates = [];

      for await (const _ of aggregator.processResponse(emptyChunk)) {
        // consume
      }

      const finalResponse = aggregator.close();
      expect(finalResponse).toBeUndefined();
    });
  });

  describe('Metadata and Helper checks', () => {
    it('isEmptyContentPart should correctly identify non-empty parts with fileData', () => {
      const filePart: Part = {
        fileData: {
          fileUri: 'https://example.com/img.png',
          mimeType: 'image/png',
        },
      };
      expect(isEmptyContentPart(filePart)).toBe(false);

      const emptyPart: Part = {
        text: '',
      };
      expect(isEmptyContentPart(emptyPart)).toBe(true);
    });

    it('should capture metadata on trailing empty chunk early return', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      // 1. Simulate function call
      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // consume
      }

      // 2. Simulate trailing empty STOP chunk with metadata
      const response2 = createResponse({
        content: {
          parts: [{text: ''}],
        },
        finishReason: FinishReason.STOP,
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
      });
      response2.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      const yieldResults = [];
      for await (const res of aggregator.processResponse(response2)) {
        yieldResults.push(res);
      }

      // verify that it returned early (yielded nothing new)
      expect(yieldResults).toHaveLength(0);

      // 3. Close the aggregator and verify metadata was preserved
      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
      expect(finalResponse?.groundingMetadata).toEqual({
        groundingChunks: [{web: {uri: 'https://google.com', title: 'Google'}}],
      });
    });

    it('should capture metadata on trailing empty chunk with zero parts early return', async () => {
      const aggregator = new StreamingResponseAggregator(true);

      // 1. Simulate function call
      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      for await (const _ of aggregator.processResponse(response1)) {
        // consume
      }

      // 2. Simulate trailing empty STOP chunk with no candidates or empty parts
      const response2 = createResponse({
        finishReason: FinishReason.STOP,
      });
      response2.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      const yieldResults = [];
      for await (const res of aggregator.processResponse(response2)) {
        yieldResults.push(res);
      }

      // verify that it returned early (yielded nothing new)
      expect(yieldResults).toHaveLength(0);

      // 3. Close the aggregator and verify metadata was preserved
      const finalResponse = aggregator.close();
      expect(finalResponse).toBeTruthy();
      expect(finalResponse?.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
    });

    it('should preserve metadata in close() when no text parts are accumulated in non-progressive mode', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      // 1. Simulate a chunk carrying a function call (no text parts)
      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const results1 = [];
      for await (const res of aggregator.processResponse(response1)) {
        results1.push(res);
      }
      expect(results1).toHaveLength(1);

      // 2. Trailing empty STOP chunk with usageMetadata
      const response2 = createResponse({
        finishReason: FinishReason.STOP,
      });
      response2.usageMetadata = {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40,
      };

      const results2 = [];
      for await (const res of aggregator.processResponse(response2)) {
        results2.push(res);
      }
      expect(results2).toHaveLength(0); // Suppressed early return

      // 3. Call close() and verify metadata is returned and parts array is empty
      const finalResponse = aggregator.close();
      expect(finalResponse).toBeDefined();
      expect(finalResponse?.content?.parts).toEqual([]);
      expect(finalResponse?.usageMetadata).toEqual({
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40,
      });
    });
  });

  describe('Additional Suppressing Tests in Non-Progressive Mode', () => {
    it('should suppress trailing empty STOP chunk with zero parts after a function call in non-progressive mode', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      // 1. Chunk with a function call
      const response1 = createResponse({
        content: {
          parts: [
            {
              functionCall: {
                name: 'get_weather',
                args: {location: 'San Francisco'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
      });

      const results1 = [];
      for await (const res of aggregator.processResponse(response1)) {
        results1.push(res);
      }
      expect(results1).toHaveLength(1);
      expect(results1[0].content?.parts?.[0]?.functionCall?.name).toBe(
        'get_weather',
      );

      // 2. Trailing empty STOP chunk with zero parts
      const response2 = createResponse({
        finishReason: FinishReason.STOP,
      });

      const results2 = [];
      for await (const res of aggregator.processResponse(response2)) {
        results2.push(res);
      }
      expect(results2).toHaveLength(0); // Should be suppressed/returned early
    });

    it('should suppress trailing empty STOP chunk for normal text streams in non-progressive mode', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      // 1. Chunk with text
      const response1 = createResponse({
        content: {parts: [{text: 'Hello '}]},
        finishReason: FinishReason.STOP,
      });

      const results1 = [];
      for await (const res of aggregator.processResponse(response1)) {
        results1.push(res);
      }
      expect(results1).toHaveLength(1);

      // 2. Trailing empty STOP chunk
      const response2 = createResponse({
        finishReason: FinishReason.STOP,
      });

      const results2 = [];
      for await (const res of aggregator.processResponse(response2)) {
        results2.push(res);
      }
      expect(results2).toHaveLength(0); // Should be suppressed
    });

    it('should NOT suppress trailing empty chunk with non-STOP finish reason in non-progressive mode', async () => {
      const aggregator = new StreamingResponseAggregator(false);

      // 1. Trailing empty chunk with SAFETY block
      const response = createResponse({
        finishReason: FinishReason.SAFETY,
      });

      const results = [];
      for await (const res of aggregator.processResponse(response)) {
        results.push(res);
      }
      expect(results).toHaveLength(1); // Should NOT be suppressed, because it is an error
      expect(results[0].errorCode).toBe(FinishReason.SAFETY);
    });
  });
});
