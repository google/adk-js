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
  Language,
  Part,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  GeminiStreamingResponseAggregator,
  isEmptyContentPart,
} from '../../src/utils/streaming_utils.js';

// Mock generateClientFunctionCallId to return a fixed ID for testing
vi.mock('../../src/events/event.js', async () => {
  const actual = (await vi.importActual(
    '../../src/events/event.js',
  )) as typeof import('../../src/events/event.js');
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

describe('GeminiStreamingResponseAggregator', () => {
  describe('Progressive Mode', () => {
    it('should aggregate text chunks', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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

      expect(results.length).toBe(2);
      expect(results[0].partial).toBe(true);
      expect(results[0].content?.parts).toEqual([{text: 'Some text '}]);

      expect(results[1].partial).toBe(false);
      expect(results[1].content?.parts).toEqual([{text: 'Some text '}]);

      expect(aggregator.close()?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'get_weather',
            args: {location: 'San Francisco'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should emit tool calls once, from close', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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

      expect(results.length).toBe(2);
      expect(results[1].content?.parts).toEqual([
        {text: 'Let me help with that. '},
      ]);
      expect(results.some((r) => r.content?.parts?.[0]?.functionCall)).toBe(
        false,
      );
      expect(aggregator.close()?.content?.parts).toEqual([
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

    it('should emit parallel calls from separate chunks as one event, keeping the signature only on the first', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });
      const chunks: Part[][] = [
        [
          {
            functionCall: {name: 'get_weather', args: {city: 'Paris'}},
            thoughtSignature: 'signature-a',
          },
        ],
        [{functionCall: {name: 'get_time', args: {city: 'Paris'}}}],
        [{functionCall: {name: 'get_weather', args: {city: 'Lima'}}}],
        // Trailing signature-only text does not end the run of calls.
        [{text: '', thoughtSignature: 'signature-b'}],
      ];

      const results = [];
      for (const parts of chunks) {
        for await (const res of aggregator.processResponse(
          createResponse({content: {role: 'model', parts}}),
        )) {
          results.push(res);
        }
      }

      expect(
        results.filter((r) => r.content?.parts?.some((p) => p.functionCall)),
      ).toEqual([]);
      expect(aggregator.close()?.content?.parts).toEqual([
        {
          functionCall: {
            name: 'get_weather',
            args: {city: 'Paris'},
            id: 'mocked-fc-id',
          },
          thoughtSignature: 'signature-a',
        },
        {
          functionCall: {
            name: 'get_time',
            args: {city: 'Paris'},
            id: 'mocked-fc-id',
          },
        },
        {
          functionCall: {
            name: 'get_weather',
            args: {city: 'Lima'},
            id: 'mocked-fc-id',
          },
        },
      ]);
    });

    it('should flush held calls before text that follows them', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });
      const chunks: Part[][] = [
        [{functionCall: {name: 'first', args: {}}, thoughtSignature: 'sig'}],
        [{functionCall: {name: 'second', args: {}}}, {text: 'Done.'}],
      ];

      const results = [];
      for (const parts of chunks) {
        for await (const res of aggregator.processResponse(
          createResponse({content: {role: 'model', parts}}),
        )) {
          results.push(res);
        }
      }

      expect(results.map((r) => [r.partial, r.content?.parts])).toEqual([
        [
          false,
          [
            {
              functionCall: {name: 'first', args: {}, id: 'mocked-fc-id'},
              thoughtSignature: 'sig',
            },
            {functionCall: {name: 'second', args: {}, id: 'mocked-fc-id'}},
          ],
        ],
        [true, [{text: 'Done.'}]],
      ]);
      expect(aggregator.close()?.content?.parts).toEqual([{text: 'Done.'}]);
    });

    it('should split mixed text and tool-call chunks into saveable events', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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

      expect(results.length).toBe(1);
      expect(results[0].partial).toBe(false);
      expect(results[0].content?.parts).toEqual([
        {text: 'Let me help with that. '},
      ]);
      expect(aggregator.close()?.content?.parts).toEqual([
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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });
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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });
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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });
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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: true,
      });

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

    it('should preserve metadata in close() when no parts are accumulated in non-progressive mode', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

      // 1. Simulate a chunk carrying code (flushed as it arrives, so nothing
      // is left for close())
      const response1 = createResponse({
        content: {
          parts: [
            {executableCode: {code: 'print(1)', language: Language.PYTHON}},
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

      // 3. Call close() and verify the trailing usage metadata is preserved
      // WITHOUT emitting an empty-parts model content. Emitting
      // `content: { parts: [] }` here corrupts the session history and makes the
      // Vertex AI backend reject the next request with HTTP 400 "must include at
      // least one parts field" (google/adk-js#21, #22); the metadata-only
      // close() response therefore omits `content` entirely.
      const finalResponse = aggregator.close();
      expect(finalResponse).toBeDefined();
      expect(finalResponse?.content).toBeUndefined();
      expect(finalResponse?.usageMetadata).toEqual({
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40,
      });
    });
  });

  describe('Additional Suppressing Tests in Non-Progressive Mode', () => {
    it('should suppress trailing empty STOP chunk with zero parts after a function call in non-progressive mode', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      expect(results1).toHaveLength(0);

      // 2. Trailing empty STOP chunk with zero parts
      const response2 = createResponse({
        finishReason: FinishReason.STOP,
      });

      const results2 = [];
      for await (const res of aggregator.processResponse(response2)) {
        results2.push(res);
      }
      expect(results2).toHaveLength(0); // Should be suppressed/returned early

      const finalResponse = aggregator.close();
      expect(finalResponse?.errorCode).toBeUndefined();
      expect(finalResponse?.content?.parts?.[0]?.functionCall?.name).toBe(
        'get_weather',
      );
    });

    it('should suppress trailing empty STOP chunk for normal text streams in non-progressive mode', async () => {
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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
      const aggregator = new GeminiStreamingResponseAggregator({
        isProgressiveMode: false,
      });

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

describe('GeminiStreamingResponseAggregator with inline audio', () => {
  async function process(
    aggregator: GeminiStreamingResponseAggregator,
    responses: GenerateContentResponse[],
  ) {
    const results = [];
    for (const response of responses) {
      for await (const result of aggregator.processResponse(response)) {
        results.push(result);
      }
    }
    return results;
  }

  const audioPart: Part = {inlineData: {mimeType: 'audio/pcm', data: 'AAAA'}};

  it('does not flush buffered text before a chunk that starts with inline data', async () => {
    const aggregator = new GeminiStreamingResponseAggregator({
      isProgressiveMode: false,
    });

    const results = await process(aggregator, [
      createResponse({content: {parts: [{text: 'Hello '}]}}),
      createResponse({content: {role: 'model', parts: [audioPart]}}),
      createResponse({content: {parts: [{text: 'world'}]}}),
    ]);

    expect(results.map((r) => [r.content?.parts, r.partial])).toEqual([
      [[{text: 'Hello '}], true],
      [[audioPart], false],
      [[{text: 'world'}], true],
    ]);
    expect(aggregator.close()?.content?.parts).toEqual([{text: 'Hello world'}]);
  });

  it('flushes buffered text when the inline data is not the first part', async () => {
    const aggregator = new GeminiStreamingResponseAggregator({
      isProgressiveMode: false,
    });

    const results = await process(aggregator, [
      createResponse({content: {parts: [{text: 'Hello'}]}}),
      createResponse({
        content: {role: 'model', parts: [{text: ' there'}, audioPart]},
      }),
    ]);

    expect(results.map((r) => [r.content?.parts, r.partial])).toEqual([
      [[{text: 'Hello'}], true],
      [[{text: 'Hello there'}], false],
      [[audioPart], false],
    ]);
    expect(aggregator.close()).toBeUndefined();
  });

  it('keeps flushing buffered text before other non-text parts', async () => {
    const aggregator = new GeminiStreamingResponseAggregator({
      isProgressiveMode: false,
    });
    const filePart: Part = {
      fileData: {mimeType: 'image/png', fileUri: 'gs://bucket/image.png'},
    };

    const results = await process(aggregator, [
      createResponse({content: {parts: [{text: 'See'}]}}),
      createResponse({content: {role: 'model', parts: [filePart]}}),
    ]);

    expect(results.map((r) => [r.content?.parts, r.partial])).toEqual([
      [[{text: 'See'}], true],
      [[{text: 'See'}], false],
      [[filePart], false],
    ]);
  });
});

describe('GeminiStreamingResponseAggregator with parallel function calls', () => {
  async function process(
    aggregator: GeminiStreamingResponseAggregator,
    chunks: Array<Part[] | Candidate>,
  ) {
    const results = [];
    for (const chunk of chunks) {
      const candidate: Candidate = Array.isArray(chunk)
        ? {content: {role: 'model', parts: chunk}}
        : chunk;
      for await (const result of aggregator.processResponse(
        createResponse(candidate),
      )) {
        results.push(result);
      }
    }
    return results;
  }

  function call(name: string, thoughtSignature?: string, id?: string): Part {
    return {
      functionCall: {name, args: {}, ...(id ? {id} : {})},
      ...(thoughtSignature ? {thoughtSignature} : {}),
    };
  }

  function summarize(parts: Part[] | undefined) {
    return (parts ?? []).map((p) =>
      p.functionCall
        ? `call:${p.functionCall.name}${p.thoughtSignature ? `+${p.thoughtSignature}` : ''}`
        : `${p.thought ? 'thought' : 'text'}:${p.text}`,
    );
  }

  function nonProgressive() {
    return new GeminiStreamingResponseAggregator({isProgressiveMode: false});
  }

  it('never yields function calls in partial events', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [{text: 'Checking ', thought: true}],
      [{text: 'Let me look. '}],
      [call('a', 'sig-a')],
      [call('b'), {text: 'Between. '}],
      [{text: 'More. '}, call('c', 'sig-c')],
      [call('d')],
    ]);
    const finalResponse = aggregator.close();

    for (const result of results) {
      if (result.partial) {
        expect(result.content?.parts?.some((p) => p.functionCall)).toBe(false);
      }
    }
    const allCalls = [...results, finalResponse!]
      .filter((r) => !r.partial)
      .flatMap((r) => r.content?.parts ?? [])
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall!.name);
    expect(allCalls).toEqual(['a', 'b', 'c', 'd']);
  });

  it('emits thoughts before the calls and groups the calls, as Gemini 3 streams them with thinking on', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [{text: 'Planning ', thought: true}],
      [{text: 'the lookups.', thought: true}],
      [call('get_weather', 'sig-1')],
      [call('get_time')],
      [call('get_weather')],
      {
        content: {role: 'model', parts: [{text: ''}]},
        finishReason: FinishReason.STOP,
      },
    ]);
    const finalResponse = aggregator.close();

    expect(
      results.filter((r) => !r.partial).map((r) => summarize(r.content?.parts)),
    ).toEqual([['thought:Planning the lookups.']]);
    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:get_weather+sig-1',
      'call:get_time',
      'call:get_weather',
    ]);
    expect(finalResponse?.partial).toBe(false);
    expect(finalResponse?.errorCode).toBeUndefined();
  });

  it('emits the text before the calls as its own event, as Gemini 3 streams text then calls', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [{text: 'I will check '}],
      [{text: 'both cities.'}],
      [call('get_weather', 'sig-1')],
      [call('get_weather')],
    ]);
    const finalResponse = aggregator.close();

    expect(
      results.map((r) => [r.partial, summarize(r.content?.parts)]),
    ).toEqual([
      [true, ['text:I will check ']],
      [true, ['text:both cities.']],
      [false, ['text:I will check both cities.']],
    ]);
    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:get_weather+sig-1',
      'call:get_weather',
    ]);
  });

  it('keeps calls that arrive in one chunk together, as Gemini 2.5 streams them', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      {
        content: {
          role: 'model',
          parts: [call('a', 'sig-a'), call('b'), call('c')],
        },
        finishReason: FinishReason.STOP,
      },
    ]);
    const finalResponse = aggregator.close();

    expect(results).toEqual([]);
    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:a+sig-a',
      'call:b',
      'call:c',
    ]);
    expect(finalResponse?.finishReason).toBe(FinishReason.STOP);
  });

  it('keeps a call that follows a signature-only empty text part in the same run', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [
        call('a', 'sig-a'),
        {text: '', thoughtSignature: 'sig-empty'},
        call('b'),
      ],
    ]);
    const finalResponse = aggregator.close();

    expect(
      results.some((r) => r.content?.parts?.some((p) => p.functionCall)),
    ).toBe(false);
    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:a+sig-a',
      'call:b',
    ]);
  });

  it('returns held calls together with the error when the stream ends with a non-STOP finish reason', async () => {
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [call('a', 'sig-a')],
      [call('b')],
      {
        content: {role: 'model', parts: [{text: ''}]},
        finishReason: FinishReason.MAX_TOKENS,
        finishMessage: 'Output truncated.',
      },
    ]);
    const finalResponse = aggregator.close();

    expect(
      results.some((r) => r.content?.parts?.some((p) => p.functionCall)),
    ).toBe(false);
    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:a+sig-a',
      'call:b',
    ]);
    expect(finalResponse?.partial).toBe(false);
    expect(finalResponse?.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(finalResponse?.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(finalResponse?.errorMessage).toBe('Output truncated.');
  });

  it('does not copy a signature onto calls separated from it by text', async () => {
    // Known gap: text between calls ends the run, so the later call lands in
    // its own content without a signature. It must not get a copy of the
    // earlier signature (google/adk-js#1187).
    const aggregator = nonProgressive();

    const results = await process(aggregator, [
      [call('a', 'sig-a')],
      [{text: 'Now the second one.'}],
      [call('b')],
    ]);
    const finalResponse = aggregator.close();

    expect(
      results.filter((r) => !r.partial).map((r) => summarize(r.content?.parts)),
    ).toEqual([['call:a+sig-a'], ['text:Now the second one.']]);
    expect(summarize(finalResponse?.content?.parts)).toEqual(['call:b']);
  });

  it('keeps server-provided call ids and generates the missing ones', async () => {
    const aggregator = nonProgressive();

    await process(aggregator, [
      [call('a', 'sig-a', 'server-id-a')],
      [call('b')],
    ]);
    const finalResponse = aggregator.close();

    expect(
      finalResponse?.content?.parts?.map((p) => p.functionCall?.id),
    ).toEqual(['server-id-a', 'mocked-fc-id']);
  });

  it('does not copy the first signature onto later calls in progressive mode', async () => {
    const aggregator = new GeminiStreamingResponseAggregator({
      isProgressiveMode: true,
    });

    await process(aggregator, [[call('a', 'sig-a')], [call('b')], [call('c')]]);
    const finalResponse = aggregator.close();

    expect(summarize(finalResponse?.content?.parts)).toEqual([
      'call:a+sig-a',
      'call:b',
      'call:c',
    ]);
  });
});
