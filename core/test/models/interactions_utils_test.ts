/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Content,
  FinishReason,
  FunctionCall,
  FunctionResponse,
  GenerateContentConfig,
  Outcome,
  Part,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  convertContentToTurn,
  convertInteractionEventToLlmResponse,
  convertInteractionOutputToPart,
  convertInteractionToLlmResponse,
  convertPartToInteractionContent,
  convertToolsConfigToInteractionsFormat,
  extractSystemInstruction,
  generateContentViaInteractions,
  getLatestUserContents,
} from '../../src/models/interactions_utils.js';

describe('interactions_utils', () => {
  describe('getLatestUserContents', () => {
    it('should return empty array for empty input', () => {
      expect(getLatestUserContents([])).toEqual([]);
    });

    it('should return only the latest continuous user messages', () => {
      const contents: Content[] = [
        {role: 'user', parts: [{text: 'Hello'}]},
        {role: 'model', parts: [{text: 'Hi'}]},
        {role: 'user', parts: [{text: 'How are you?'}]},
        {role: 'user', parts: [{text: 'Today is sunny'}]},
      ];

      const expected: Content[] = [
        {role: 'user', parts: [{text: 'How are you?'}]},
        {role: 'user', parts: [{text: 'Today is sunny'}]},
      ];

      expect(getLatestUserContents(contents)).toEqual(expected);
    });

    it('should include preceding model function call when user content has function response', () => {
      const contents: Content[] = [
        {role: 'user', parts: [{text: 'Call tool'}]},
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'my_tool',
                args: {arg1: 'val1'},
                id: 'call-1',
              } as FunctionCall,
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'my_tool',
                response: {result: 'success'},
                id: 'call-1',
              } as FunctionResponse,
            },
          ],
        },
      ];

      const expected: Content[] = [
        contents[1], // model function call
        contents[2], // user function response
      ];

      expect(getLatestUserContents(contents)).toEqual(expected);
    });

    it('should not include preceding turn if it is not a model turn with function call', () => {
      const contents: Content[] = [
        {role: 'model', parts: [{text: 'some model text'}]},
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'my_tool',
                response: {result: 'success'},
                id: 'call-1',
              } as FunctionResponse,
            },
          ],
        },
      ];
      const expected: Content[] = [contents[1]];
      expect(getLatestUserContents(contents)).toEqual(expected);
    });
  });

  describe('convertPartToInteractionContent', () => {
    it('should convert text part', () => {
      const part: Part = {text: 'Hello'};
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'text',
        text: 'Hello',
      });
    });

    it('should convert function call part', () => {
      const part: Part = {
        functionCall: {
          name: 'test_tool',
          args: {a: 1},
          id: 'call-123',
        } as FunctionCall,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_call',
        id: 'call-123',
        name: 'test_tool',
        arguments: {a: 1},
      });
    });

    it('should convert function call part with missing id and args', () => {
      const part: Part = {
        functionCall: {
          name: 'test_tool',
        } as FunctionCall,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_call',
        id: '',
        name: 'test_tool',
        arguments: {},
      });
    });

    it('should convert function call part with thought signature', () => {
      const part: Part = {
        functionCall: {
          name: 'test_tool',
          args: {a: 1},
          id: 'call-123',
        } as FunctionCall,
        thoughtSignature: Buffer.from('sig-data'),
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_call',
        id: 'call-123',
        name: 'test_tool',
        arguments: {a: 1},
        signature: 'c2lnLWRhdGE=',
      });
    });

    it('should convert function response part', () => {
      const part: Part = {
        functionResponse: {
          name: 'test_tool',
          response: {result: 'ok'},
          id: 'call-123',
        } as FunctionResponse,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_result',
        name: 'test_tool',
        call_id: 'call-123',
        result: {result: 'ok'},
      });
    });

    it('should convert function response part with missing name and id', () => {
      const part: Part = {
        functionResponse: {
          response: {result: 'ok'},
        } as FunctionResponse,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_result',
        name: '',
        call_id: '',
        result: {result: 'ok'},
      });
    });

    it('should convert function response part with primitive response', () => {
      const part: Part = {
        functionResponse: {
          name: 'test_tool',
          response: true,
          id: 'call-123',
        } as FunctionResponse,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_result',
        name: 'test_tool',
        call_id: 'call-123',
        result: 'true',
      });
    });

    it('should convert inline image data', () => {
      const part: Part = {
        inlineData: {
          data: 'base64data',
          mimeType: 'image/png',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'image',
        data: 'base64data',
        mime_type: 'image/png',
      });
    });

    it('should convert file image data', () => {
      const part: Part = {
        fileData: {
          fileUri: 'gs://bucket/img.png',
          mimeType: 'image/png',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'image',
        uri: 'gs://bucket/img.png',
        mime_type: 'image/png',
      });
    });

    it('should convert code execution result', () => {
      const part: Part = {
        codeExecutionResult: {
          output: 'success output',
          outcome: Outcome.OUTCOME_OK,
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'code_execution_result',
        call_id: '',
        result: 'success output',
        is_error: false,
      });
    });

    it('should convert executable code', () => {
      const part: Part = {
        executableCode: {
          code: 'print("hello")',
          language: 'PYTHON',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'code_execution_call',
        id: '',
        arguments: {
          code: 'print("hello")',
          language: 'PYTHON',
        },
      });
    });

    it('should convert thought part', () => {
      const part: Part = {
        thought: true,
        thoughtSignature: Buffer.from('base64data'),
      } as any;
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'thought',
        signature: 'YmFzZTY0ZGF0YQ==',
      });
    });

    it('should convert inline audio data', () => {
      const part: Part = {
        inlineData: {
          data: 'audiodata',
          mimeType: 'audio/mp3',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'audio',
        data: 'audiodata',
        mime_type: 'audio/mp3',
      });
    });

    it('should convert inline video data', () => {
      const part: Part = {
        inlineData: {
          data: 'videodata',
          mimeType: 'video/mp4',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'video',
        data: 'videodata',
        mime_type: 'video/mp4',
      });
    });

    it('should convert inline document data', () => {
      const part: Part = {
        inlineData: {
          data: 'docdata',
          mimeType: 'application/pdf',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'document',
        data: 'docdata',
        mime_type: 'application/pdf',
      });
    });

    it('should convert file audio data', () => {
      const part: Part = {
        fileData: {
          fileUri: 'gs://bucket/audio.mp3',
          mimeType: 'audio/mp3',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'audio',
        uri: 'gs://bucket/audio.mp3',
        mime_type: 'audio/mp3',
      });
    });

    it('should convert file video data', () => {
      const part: Part = {
        fileData: {
          fileUri: 'gs://bucket/video.mp4',
          mimeType: 'video/mp4',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'video',
        uri: 'gs://bucket/video.mp4',
        mime_type: 'video/mp4',
      });
    });

    it('should convert file document data', () => {
      const part: Part = {
        fileData: {
          fileUri: 'gs://bucket/doc.pdf',
          mimeType: 'application/pdf',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'document',
        uri: 'gs://bucket/doc.pdf',
        mime_type: 'application/pdf',
      });
    });

    it('should convert function call part with string thought signature', () => {
      const part: Part = {
        functionCall: {
          name: 'test_tool',
          args: {a: 1},
          id: 'call-123',
        } as FunctionCall,
        thoughtSignature: 'sig-data-string' as any,
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'function_call',
        id: 'call-123',
        name: 'test_tool',
        arguments: {a: 1},
        signature: 'c2lnLWRhdGEtc3RyaW5n',
      });
    });

    it('should convert function call part with thought signature in browser environment', () => {
      const originalWindow = global.window;
      (global as any).window = {
        btoa: (str: string) => Buffer.from(str, 'binary').toString('base64'),
      };

      const part: Part = {
        functionCall: {
          name: 'test_tool',
          args: {a: 1},
          id: 'call-123',
        } as FunctionCall,
        thoughtSignature: new TextEncoder().encode('sig-data-browser') as any,
      };

      const result = convertPartToInteractionContent(part);
      expect(result?.signature).toBe('c2lnLWRhdGEtYnJvd3Nlcg==');

      (global as any).window = originalWindow;
    });

    it('should convert inlineData with missing mimeType to document', () => {
      const part: Part = {
        inlineData: {
          data: 'docdata',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'document',
        data: 'docdata',
        mime_type: '',
      });
    });

    it('should convert fileData with missing mimeType to document', () => {
      const part: Part = {
        fileData: {
          fileUri: 'gs://bucket/doc.pdf',
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'document',
        uri: 'gs://bucket/doc.pdf',
        mime_type: '',
      });
    });

    it('should convert codeExecutionResult with missing output', () => {
      const part: Part = {
        codeExecutionResult: {
          outcome: Outcome.OUTCOME_OK,
        },
      };
      expect(convertPartToInteractionContent(part)).toEqual({
        type: 'code_execution_result',
        call_id: '',
        result: '',
        is_error: false,
      });
    });

    it('should return null for empty or invalid part', () => {
      expect(convertPartToInteractionContent({})).toBeNull();
    });
  });

  describe('convertToolsConfigToInteractionsFormat', () => {
    it('should convert function declarations and built-in tools', () => {
      const config = {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'tool1',
                description: 'desc1',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    param1: {type: 'STRING'},
                  },
                  required: ['param1'],
                },
              },
            ],
          },
          {googleSearch: {}},
          {codeExecution: {}},
        ],
      };

      const expected = [
        {
          type: 'function',
          name: 'tool1',
          description: 'desc1',
          parameters: {
            type: 'object',
            properties: {
              param1: {type: 'STRING'},
            },
            required: ['param1'],
          },
        },
        {type: 'google_search'},
        {type: 'code_execution'},
      ];

      expect(convertToolsConfigToInteractionsFormat(config as any)).toEqual(
        expected,
      );
    });

    it('should convert function declarations without required parameters', () => {
      const config = {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'tool1_no_req',
                description: 'desc_no_req',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    param1: {type: 'STRING'},
                  },
                },
              },
            ],
          },
        ],
      };

      const expected = [
        {
          type: 'function',
          name: 'tool1_no_req',
          description: 'desc_no_req',
          parameters: {
            type: 'object',
            properties: {
              param1: {type: 'STRING'},
            },
            required: undefined,
          },
        },
      ];

      expect(convertToolsConfigToInteractionsFormat(config as any)).toEqual(
        expected,
      );
    });

    it('should convert function declarations with parametersJsonSchema and urlContext', () => {
      const config = {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'tool2',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    param2: {type: 'string'},
                  },
                },
              },
            ],
          },
          {urlContext: {}},
        ],
      };

      const expected = [
        {
          type: 'function',
          name: 'tool2',
          parameters: {
            type: 'object',
            properties: {
              param2: {type: 'string'},
            },
          },
        },
        {type: 'url_context'},
      ];

      expect(convertToolsConfigToInteractionsFormat(config as any)).toEqual(
        expected,
      );
    });
  });

  describe('convertInteractionToLlmResponse', () => {
    it('should convert successful interaction response', () => {
      const interaction = {
        id: 'int-123',
        status: 'completed',
        outputs: [{type: 'text', text: 'Response text'}],
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 20,
        },
      };

      const response = convertInteractionToLlmResponse(interaction);

      expect(response.interactionId).toBe('int-123');
      expect(response.turnComplete).toBe(true);
      expect(response.content?.role).toBe('model');
      expect(response.content?.parts?.[0]?.text).toBe('Response text');
      expect(response.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
      expect(response.finishReason).toBe('STOP');
    });

    it('should convert failed interaction response', () => {
      const interaction = {
        id: 'int-123',
        status: 'failed',
        error: {
          code: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
        },
      };

      const response = convertInteractionToLlmResponse(interaction);

      expect(response.interactionId).toBe('int-123');
      expect(response.errorCode).toBe('RESOURCE_EXHAUSTED');
      expect(response.errorMessage).toBe('Quota exceeded');
    });

    it('should convert failed interaction response with missing error details', () => {
      const interaction = {
        id: 'int-123',
        status: 'failed',
        error: {},
      };
      const response = convertInteractionToLlmResponse(interaction);
      expect(response.errorCode).toBe('UNKNOWN_ERROR');
      expect(response.errorMessage).toBe('Unknown error');
    });

    it('should handle missing token counts in usage', () => {
      const interaction = {
        id: 'int-123',
        status: 'completed',
        usage: {},
      };
      const response = convertInteractionToLlmResponse(interaction);
      expect(response.usageMetadata).toEqual({
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      });
    });

    it('should handle requires_action status', () => {
      const interaction = {
        id: 'int-123',
        status: 'requires_action',
      };
      const response = convertInteractionToLlmResponse(interaction);
      expect(response.turnComplete).toBe(true);
      expect(response.finishReason).toBe('STOP');
    });
  });

  describe('convertInteractionEventToLlmResponse', () => {
    it('should handle content.delta text event', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'text',
          text: 'hello',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toEqual({
        content: {role: 'model', parts: [{text: 'hello'}]},
        partial: true,
        turnComplete: false,
        interactionId: 'int-1',
      });
      expect(aggregatedParts).toEqual([{text: 'hello'}]);
    });

    it('should accumulate function call delta without yielding immediately', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'function_call',
          name: 'my_tool',
          arguments: {x: 1},
          id: 'call-1',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toBeNull();
      expect(aggregatedParts).toEqual([
        {
          functionCall: {
            id: 'call-1',
            name: 'my_tool',
            args: {x: 1},
          } as FunctionCall,
          thoughtSignature: undefined,
        },
      ]);
    });

    it('should handle content.delta function_call with missing delta id', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'function_call',
          name: 'my_tool',
        },
      };
      const aggregatedParts: Part[] = [];
      convertInteractionEventToLlmResponse(event, aggregatedParts, 'int-1');
      expect(aggregatedParts[0].functionCall?.id).toBe('');
    });

    it('should handle content.stop event and return aggregated parts', () => {
      const event = {event_type: 'content.stop'};
      const aggregatedParts: Part[] = [{text: 'hello '}, {text: 'world'}];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toEqual({
        content: {role: 'model', parts: [{text: 'hello '}, {text: 'world'}]},
        partial: false,
        turnComplete: false,
        interactionId: 'int-1',
      });
    });

    it('should handle interaction.status_update completed event', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'completed',
      };
      const aggregatedParts: Part[] = [{text: 'final text'}];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toEqual({
        content: {role: 'model', parts: [{text: 'final text'}]},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP' as FinishReason,
        interactionId: 'int-1',
      });
    });
  });

  describe('generateContentViaInteractions', () => {
    it('should handle non-streaming call', async () => {
      const mockInteraction = {
        id: 'int-999',
        status: 'completed',
        outputs: [{type: 'text', text: 'Mocked static response'}],
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockInteraction),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        false,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }

      expect(responses.length).toBe(1);
      expect(responses[0].content?.parts?.[0]?.text).toBe(
        'Mocked static response',
      );
      expect(responses[0].interactionId).toBe('int-999');

      expect(mockApiClient.interactions.create).toHaveBeenCalledWith({
        model: 'gemini-2.5-flash',
        input: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Hello'}],
          },
        ],
        stream: false,
        system_instruction: undefined,
        tools: undefined,
        generation_config: undefined,
        previous_interaction_id: undefined,
      });
    });

    it('should handle streaming call', async () => {
      const mockEvents = [
        {
          event_type: 'content.delta',
          delta: {type: 'text', text: 'Part 1'},
          interaction_id: 'int-stream',
        },
        {
          event_type: 'content.delta',
          delta: {type: 'text', text: 'Part 2'},
        },
        {
          event_type: 'interaction.status_update',
          status: 'completed',
        },
      ];

      // Create an async iterable mock
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello stream'}]}],
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        true,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }

      // We expect:
      // 1. Response for Part 1 delta (partial: true)
      // 2. Response for Part 2 delta (partial: true)
      // 3. Response for status_update completed (turnComplete: true)
      // 4. Final aggregated response yielded at the end of generator
      expect(responses.length).toBe(4);

      expect(responses[0]).toEqual({
        content: {role: 'model', parts: [{text: 'Part 1'}]},
        partial: true,
        turnComplete: false,
        interactionId: 'int-stream',
      });

      expect(responses[1]).toEqual({
        content: {role: 'model', parts: [{text: 'Part 2'}]},
        partial: true,
        turnComplete: false,
        interactionId: 'int-stream',
      });

      expect(responses[2]).toEqual({
        content: {role: 'model', parts: [{text: 'Part 1'}, {text: 'Part 2'}]},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'int-stream',
      });

      expect(responses[3]).toEqual({
        content: {role: 'model', parts: [{text: 'Part 1'}, {text: 'Part 2'}]},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'int-stream',
      });
    });

    it('should trim history when previousInteractionId is present', async () => {
      const mockInteraction = {
        id: 'int-999',
        status: 'completed',
        outputs: [{type: 'text', text: 'Mocked response'}],
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockInteraction),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [
          {role: 'user', parts: [{text: 'Turn 1'}]},
          {role: 'model', parts: [{text: 'Reply 1'}]},
          {role: 'user', parts: [{text: 'Turn 2'}]},
        ],
        previousInteractionId: 'int-prev',
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        false,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }

      expect(responses.length).toBe(1);
      expect(mockApiClient.interactions.create).toHaveBeenCalledWith({
        model: 'gemini-2.5-flash',
        input: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Turn 2'}],
          },
        ],
        stream: false,
        system_instruction: undefined,
        tools: undefined,
        generation_config: undefined,
        previous_interaction_id: 'int-prev',
      });
    });

    it('should handle streaming call with interaction event and extract interaction ID', async () => {
      const mockEvents = [
        {
          event_type: 'content.delta',
          delta: {type: 'text', text: 'Stream text'},
        },
        {
          event_type: 'interaction',
          id: 'int-from-event',
          status: 'completed',
          outputs: [{type: 'text', text: 'Stream text'}],
        },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        true,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }

      expect(responses.length).toBe(3);

      expect(responses[0]).toEqual({
        content: {role: 'model', parts: [{text: 'Stream text'}]},
        partial: true,
        turnComplete: false,
        interactionId: undefined,
      });

      expect(responses[1].interactionId).toBe('int-from-event');
      expect(responses[1].turnComplete).toBe(true);

      expect(responses[2].interactionId).toBe('int-from-event');
    });

    it('should pass all generation config parameters', async () => {
      const mockInteraction = {
        id: 'int-999',
        status: 'completed',
        outputs: [{type: 'text', text: 'Mocked response'}],
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockInteraction),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
        config: {
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 100,
          stopSequences: ['STOP'],
          presencePenalty: 0.5,
          frequencyPenalty: 0.5,
          tools: [{functionDeclarations: [{name: 'my_tool'}]}],
        } as GenerateContentConfig,
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        false,
      );
      for await (const _ of generator) {
        // empty
      }

      expect(mockApiClient.interactions.create).toHaveBeenCalledWith({
        model: 'gemini-2.5-flash',
        input: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Hello'}],
          },
        ],
        stream: false,
        system_instruction: undefined,
        tools: [
          {
            type: 'function',
            name: 'my_tool',
          },
        ],
        generation_config: {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          max_output_tokens: 100,
          stop_sequences: ['STOP'],
          presence_penalty: 0.5,
          frequency_penalty: 0.5,
        },
        previous_interaction_id: undefined,
      });
    });

    it('should pass tools in streaming call', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            event_type: 'content.delta',
            delta: {type: 'text', text: 'Reply'},
          };
        },
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
        config: {
          tools: [{functionDeclarations: [{name: 'my_tool'}]}],
          temperature: 0.5,
        } as GenerateContentConfig,
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        true,
      );
      for await (const _ of generator) {
        // empty
      }

      expect(mockApiClient.interactions.create).toHaveBeenCalledWith({
        model: 'gemini-2.5-flash',
        input: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Hello'}],
          },
        ],
        stream: true,
        system_instruction: undefined,
        tools: [
          {
            type: 'function',
            name: 'my_tool',
          },
        ],
        generation_config: {
          temperature: 0.5,
        },
        previous_interaction_id: undefined,
      });
    });
  });

  describe('convertInteractionOutputToPart', () => {
    it('should return null for empty or invalid output', () => {
      expect(convertInteractionOutputToPart(null)).toBeNull();
      expect(convertInteractionOutputToPart({})).toBeNull();
      expect(convertInteractionOutputToPart({type: 'invalid'})).toBeNull();
    });

    it('should convert text output', () => {
      expect(
        convertInteractionOutputToPart({type: 'text', text: 'hello'}),
      ).toEqual({
        text: 'hello',
      });
    });

    it('should convert text output with missing text', () => {
      expect(convertInteractionOutputToPart({type: 'text'})).toEqual({
        text: '',
      });
    });

    it('should convert function_call output', () => {
      const output = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {a: 1},
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        functionCall: {
          id: 'call-1',
          name: 'my_tool',
          args: {a: 1},
        },
        thoughtSignature: undefined,
      });
    });

    it('should convert function_call output with missing arguments', () => {
      const output = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        functionCall: {
          id: 'call-1',
          name: 'my_tool',
          args: {},
        },
        thoughtSignature: undefined,
      });
    });

    it('should convert function_call output with non-string thought_signature', () => {
      const output = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        signature: 123 as any,
      };
      const part = convertInteractionOutputToPart(output);
      expect(part?.thoughtSignature).toBeUndefined();
    });

    it('should convert function_call output with thought_signature in browser environment', () => {
      const originalWindow = global.window;
      (global as any).window = {
        atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
      };

      const output = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {a: 1},
        signature: 'YmFzZTY0ZGF0YQ==',
      };

      const part = convertInteractionOutputToPart(output);
      expect(part?.thoughtSignature).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(part?.thoughtSignature as any).toString()).toBe(
        'base64data',
      );

      (global as any).window = originalWindow;
    });

    it('should convert function_call output with thought_signature in Node.js environment', () => {
      const output = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {a: 1},
        signature: 'YmFzZTY0ZGF0YQ==',
      };
      const part = convertInteractionOutputToPart(output);
      expect(part?.thoughtSignature).toBeInstanceOf(Buffer);
      expect(part?.thoughtSignature?.toString()).toBe('base64data');
    });

    it('should convert function_result output', () => {
      const output = {
        type: 'function_result',
        call_id: 'call-1',
        result: {res: 'ok'},
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        functionResponse: {
          id: 'call-1',
          response: {res: 'ok'},
        },
      });
    });

    it('should convert image output (data)', () => {
      const output = {
        type: 'image',
        data: 'base64data',
        mime_type: 'image/png',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        inlineData: {
          data: 'base64data',
          mimeType: 'image/png',
        },
      });
    });

    it('should convert image output (uri)', () => {
      const output = {
        type: 'image',
        uri: 'gs://bucket/img.png',
        mime_type: 'image/png',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        fileData: {
          fileUri: 'gs://bucket/img.png',
          mimeType: 'image/png',
        },
      });
    });

    it('should convert audio output (data)', () => {
      const output = {
        type: 'audio',
        data: 'base64data',
        mime_type: 'audio/mp3',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        inlineData: {
          data: 'base64data',
          mimeType: 'audio/mp3',
        },
      });
    });

    it('should convert audio output (uri)', () => {
      const output = {
        type: 'audio',
        uri: 'gs://bucket/audio.mp3',
        mime_type: 'audio/mp3',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        fileData: {
          fileUri: 'gs://bucket/audio.mp3',
          mimeType: 'audio/mp3',
        },
      });
    });

    it('should return null for thought output', () => {
      expect(convertInteractionOutputToPart({type: 'thought'})).toBeNull();
    });

    it('should convert code_execution_result output', () => {
      const output = {
        type: 'code_execution_result',
        result: 'output text',
        is_error: false,
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        codeExecutionResult: {
          output: 'output text',
          outcome: Outcome.OUTCOME_OK,
        },
      });

      const outputError = {
        type: 'code_execution_result',
        result: 'error text',
        is_error: true,
      };
      expect(convertInteractionOutputToPart(outputError)).toEqual({
        codeExecutionResult: {
          output: 'error text',
          outcome: Outcome.OUTCOME_FAILED,
        },
      });
    });

    it('should convert code_execution_result output with missing result', () => {
      const output = {
        type: 'code_execution_result',
        is_error: false,
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        codeExecutionResult: {
          output: '',
          outcome: Outcome.OUTCOME_OK,
        },
      });
    });

    it('should convert code_execution_call output', () => {
      const output = {
        type: 'code_execution_call',
        arguments: {
          code: 'print(1)',
          language: 'PYTHON',
        },
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        executableCode: {
          code: 'print(1)',
          language: 'PYTHON',
        },
      });
    });

    it('should convert code_execution_call output with missing arguments', () => {
      const output = {
        type: 'code_execution_call',
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        executableCode: {
          code: '',
          language: 'PYTHON',
        },
      });
    });

    it('should convert google_search_result output', () => {
      const output = {
        type: 'google_search_result',
        result: [{title: 'res1', url: 'url1'}, 'plain text result'],
      };
      expect(convertInteractionOutputToPart(output)).toEqual({
        text: '{"title":"res1","url":"url1"}\nplain text result',
      });
    });
  });

  describe('convertInteractionEventToLlmResponse extra cases', () => {
    it('should handle content.delta image event (data)', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'image',
          data: 'imgdata',
          mime_type: 'image/png',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );
      expect(response).toEqual({
        content: {
          role: 'model',
          parts: [
            {
              inlineData: {
                data: 'imgdata',
                mimeType: 'image/png',
              },
            },
          ],
        },
        partial: false,
        turnComplete: false,
        interactionId: 'int-1',
      });
    });

    it('should handle content.delta image event (uri)', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'image',
          uri: 'gs://img.png',
          mime_type: 'image/png',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );
      expect(response).toEqual({
        content: {
          role: 'model',
          parts: [
            {
              fileData: {
                fileUri: 'gs://img.png',
                mimeType: 'image/png',
              },
            },
          ],
        },
        partial: false,
        turnComplete: false,
        interactionId: 'int-1',
      });
    });

    it('should handle interaction.status_update failed event', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'failed',
        error: {
          code: 'CANCELLED',
          message: 'user cancelled',
        },
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        errorCode: 'CANCELLED',
        errorMessage: 'user cancelled',
        turnComplete: true,
        interactionId: 'int-1',
      });
    });

    it('should handle interaction.status_update failed event with missing error', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'failed',
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: 'Unknown error',
        turnComplete: true,
        interactionId: 'int-1',
      });
    });

    it('should handle interaction.status_update completed event with aggregated parts', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'completed',
      };
      const parts = [{text: 'part 1'}];
      const response = convertInteractionEventToLlmResponse(
        event,
        parts,
        'int-1',
      );
      expect(response).toEqual({
        content: {role: 'model', parts: [{text: 'part 1'}]},
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'int-1',
      });
    });

    it('should handle error event', () => {
      const event = {
        event_type: 'error',
        code: 'INTERNAL',
        message: 'internal error',
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        errorCode: 'INTERNAL',
        errorMessage: 'internal error',
        turnComplete: true,
        interactionId: 'int-1',
      });
    });

    it('should handle error event with missing code and message', () => {
      const event = {
        event_type: 'error',
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: 'Unknown error',
        turnComplete: true,
        interactionId: 'int-1',
      });
    });

    it('should return null if event.delta is missing in content.delta event', () => {
      const event = {
        event_type: 'content.delta',
      };
      expect(convertInteractionEventToLlmResponse(event, [])).toBeNull();
    });

    it('should handle content.delta function_call with thought_signature in browser environment', () => {
      const originalWindow = global.window;
      (global as any).window = {
        atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
      };

      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'function_call',
          name: 'my_tool',
          thought_signature: 'YmFzZTY0ZGF0YQ==',
          id: 'call-1',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toBeNull();
      expect(aggregatedParts[0].thoughtSignature).toBeDefined();
      expect(aggregatedParts[0].thoughtSignature).toBeInstanceOf(Uint8Array);
      expect(
        Buffer.from(aggregatedParts[0].thoughtSignature as any).toString(),
      ).toBe('base64data');

      (global as any).window = originalWindow;
    });

    it('should handle content.delta function_call with thought_signature in Node.js environment', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'function_call',
          name: 'my_tool',
          thought_signature: 'YmFzZTY0ZGF0YQ==',
          id: 'call-1',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );

      expect(response).toBeNull();
      expect(aggregatedParts[0].thoughtSignature).toBeInstanceOf(Buffer);
      expect(aggregatedParts[0].thoughtSignature?.toString()).toBe(
        'base64data',
      );
    });

    it('should handle event with camelCase eventType', () => {
      const event = {
        eventType: 'content.delta',
        delta: {
          type: 'text',
          text: 'camelText',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );
      expect(response?.content?.parts?.[0]?.text).toBe('camelText');
    });

    it('should handle content.delta text event with missing text', () => {
      const event = {
        event_type: 'content.delta',
        delta: {
          type: 'text',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
    });

    it('should handle interaction event type', () => {
      const event = {
        event_type: 'interaction',
        id: 'int-123',
        status: 'completed',
        outputs: [{type: 'text', text: 'final'}],
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        content: {role: 'model', parts: [{text: 'final'}]},
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'int-123',
        usageMetadata: undefined,
      });
    });

    it('should handle interaction.status_update requires_action event', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'requires_action',
      };
      const response = convertInteractionEventToLlmResponse(event, [], 'int-1');
      expect(response).toEqual({
        content: undefined,
        partial: false,
        turnComplete: true,
        finishReason: 'STOP',
        interactionId: 'int-1',
      });
    });

    it('should return null for unknown event type', () => {
      const event = {event_type: 'unknown'};
      expect(convertInteractionEventToLlmResponse(event, [])).toBeNull();
    });
  });

  describe('convertContentToTurn', () => {
    it('should convert Content to Turn with default role', () => {
      const content: Content = {
        parts: [{text: 'Hello'}],
      };
      expect(convertContentToTurn(content)).toEqual({
        role: 'user',
        content: [{type: 'text', text: 'Hello'}],
      });
    });
  });

  describe('extractSystemInstruction', () => {
    it('should return undefined if no systemInstruction', () => {
      expect(extractSystemInstruction({})).toBeUndefined();
    });

    it('should return string instruction directly', () => {
      expect(extractSystemInstruction({systemInstruction: 'be helpful'})).toBe(
        'be helpful',
      );
    });

    it('should extract text from Content systemInstruction', () => {
      const config = {
        systemInstruction: {
          role: 'system',
          parts: [{text: 'line 1'}, {text: 'line 2'}],
        } as Content,
      };
      expect(extractSystemInstruction(config)).toBe('line 1\nline 2');
    });

    it('should return undefined if systemInstruction is object but has no parts', () => {
      expect(
        extractSystemInstruction({systemInstruction: {} as any}),
      ).toBeUndefined();
    });

    it('should return undefined if Content systemInstruction parts have no text', () => {
      const config = {
        systemInstruction: {
          role: 'system',
          parts: [{}],
        } as Content,
      };
      expect(extractSystemInstruction(config)).toBeUndefined();
    });
  });

  describe('generateContentViaInteractions extra streaming cases', () => {
    it('should handle streaming call with interaction.start event and extract interaction ID from interaction object', async () => {
      const mockEvents = [
        {
          event_type: 'interaction.start',
          interaction: {id: 'int-start-id'},
        },
        {
          event_type: 'content.delta',
          delta: {type: 'text', text: 'Stream text'},
        },
        {
          event_type: 'interaction.status_update',
          status: 'completed',
        },
      ];

      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        },
      };

      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };

      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        true,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }

      expect(responses.length).toBe(3);

      expect(responses[0]).toEqual({
        content: {role: 'model', parts: [{text: 'Stream text'}]},
        partial: true,
        turnComplete: false,
        interactionId: 'int-start-id',
      });

      expect(responses[1].interactionId).toBe('int-start-id');
      expect(responses[1].turnComplete).toBe(true);
    });

    it('should extract interaction ID from interactionId (camelCase) in streaming event', async () => {
      const mockEvents = [
        {
          event_type: 'content.delta',
          delta: {type: 'text', text: 'Reply'},
          interactionId: 'int-camel-case',
        },
      ];
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield mockEvents[0];
        },
      };
      const mockApiClient = {
        interactions: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };
      const llmRequest = {
        model: 'gemini-2.5-flash',
        contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      };

      const generator = generateContentViaInteractions(
        mockApiClient as any,
        llmRequest as any,
        true,
      );
      const responses = [];
      for await (const res of generator) {
        responses.push(res);
      }
      expect(responses[0].interactionId).toBe('int-camel-case');
    });
  });
});
