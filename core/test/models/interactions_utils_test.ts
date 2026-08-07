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
  Interactions,
  Language,
  Outcome,
  Part,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  convertContentToSteps,
  convertInteractionEventToLlmResponse,
  convertInteractionToLlmResponse,
  convertStepToParts,
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

  describe('convertContentToSteps', () => {
    it('should convert text part to user_input step', () => {
      const content: Content = {
        role: 'user',
        parts: [{text: 'Hello'}],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [{type: 'text', text: 'Hello'}],
        },
      ]);
    });

    it('should convert function call part to function_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'test_tool',
              args: {a: 1},
              id: 'call-123',
            } as FunctionCall,
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_call',
          id: 'call-123',
          name: 'test_tool',
          arguments: {a: 1},
        },
      ]);
    });

    it('should convert function call part with missing id and args to function_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'test_tool',
            } as FunctionCall,
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_call',
          id: '',
          name: 'test_tool',
          arguments: {},
        },
      ]);
    });

    it('should convert function call part with thought signature to function_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'test_tool',
              args: {a: 1},
              id: 'call-123',
            } as FunctionCall,
            thoughtSignature: 'sig-data-string',
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_call',
          id: 'call-123',
          name: 'test_tool',
          arguments: {a: 1},
          signature: 'sig-data-string',
        },
      ]);
    });

    it('should convert function response part to function_result step', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'test_tool',
              response: {result: 'ok'},
              id: 'call-123',
            } as FunctionResponse,
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_result',
          name: 'test_tool',
          call_id: 'call-123',
          result: {result: 'ok'},
        },
      ]);
    });

    it('should convert function response part with missing name and id to function_result step', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              response: {result: 'ok'},
            } as FunctionResponse,
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_result',
          name: '',
          call_id: '',
          result: {result: 'ok'},
        },
      ]);
    });

    it('should convert inline image data to user_input step with image content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'base64data',
              mimeType: 'image/png',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'image',
              data: 'base64data',
              mime_type: 'image/png',
            } as any,
          ],
        },
      ]);
    });

    it('should convert file image data to user_input step with image content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'gs://bucket/img.png',
              mimeType: 'image/png',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'image',
              uri: 'gs://bucket/img.png',
              mime_type: 'image/png',
            } as any,
          ],
        },
      ]);
    });

    it('should convert code execution result to code_execution_result step', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            codeExecutionResult: {
              output: 'success output',
              outcome: Outcome.OUTCOME_OK,
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_result',
          call_id: '',
          result: 'success output',
          is_error: false,
        },
      ]);
    });

    it('should convert executable code to code_execution_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            executableCode: {
              code: 'print("hello")',
              language: Language.PYTHON,
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_call',
          id: '',
          arguments: {
            code: 'print("hello")',
            language: 'python',
          },
        },
      ]);
    });

    it('should convert thought part to thought step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            thought: true,
            thoughtSignature: 'sig-data-string',
          } as any,
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'thought',
          signature: 'sig-data-string',
        },
      ]);
    });

    it('should convert inline audio data to user_input step with audio content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'audiodata',
              mimeType: 'audio/mp3',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'audio',
              data: 'audiodata',
              mime_type: 'audio/mp3',
            } as any,
          ],
        },
      ]);
    });

    it('should convert inline video data to user_input step with video content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'videodata',
              mimeType: 'video/mp4',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'video',
              data: 'videodata',
              mime_type: 'video/mp4',
            } as any,
          ],
        },
      ]);
    });

    it('should convert inline document data to user_input step with document content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'docdata',
              mimeType: 'application/pdf',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'document',
              data: 'docdata',
              mime_type: 'application/pdf',
            } as any,
          ],
        },
      ]);
    });

    it('should convert file audio data to user_input step with audio content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'gs://bucket/audio.mp3',
              mimeType: 'audio/mp3',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'audio',
              uri: 'gs://bucket/audio.mp3',
              mime_type: 'audio/mp3',
            } as any,
          ],
        },
      ]);
    });

    it('should convert file video data to user_input step with video content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'gs://bucket/video.mp4',
              mimeType: 'video/mp4',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'video',
              uri: 'gs://bucket/video.mp4',
              mime_type: 'video/mp4',
            } as any,
          ],
        },
      ]);
    });

    it('should convert file document data to user_input step with document content', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'gs://bucket/doc.pdf',
              mimeType: 'application/pdf',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'document',
              uri: 'gs://bucket/doc.pdf',
              mime_type: 'application/pdf',
            } as any,
          ],
        },
      ]);
    });

    it('should convert inlineData with missing mimeType to document', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'docdata',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'document',
              data: 'docdata',
              mime_type: '',
            } as any,
          ],
        },
      ]);
    });

    it('should convert fileData with missing mimeType to document', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'gs://bucket/doc.pdf',
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {
              type: 'document',
              uri: 'gs://bucket/doc.pdf',
              mime_type: '',
            } as any,
          ],
        },
      ]);
    });

    it('should convert codeExecutionResult with missing output', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            codeExecutionResult: {
              outcome: Outcome.OUTCOME_OK,
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_result',
          call_id: '',
          result: '',
          is_error: false,
        },
      ]);
    });

    it('should return empty steps for empty or invalid content', () => {
      expect(convertContentToSteps({})).toEqual([]);
      expect(convertContentToSteps({parts: []})).toEqual([]);
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
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'Response text'}],
          } as Interactions.ModelOutputStep,
        ],
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 20,
        },
      };

      const response = convertInteractionToLlmResponse(interaction as any);

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

      const response = convertInteractionToLlmResponse(interaction as any);

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
      const response = convertInteractionToLlmResponse(interaction as any);
      expect(response.errorCode).toBe('UNKNOWN_ERROR');
      expect(response.errorMessage).toBe('Unknown error');
    });

    it('should handle missing token counts in usage', () => {
      const interaction = {
        id: 'int-123',
        status: 'completed',
        usage: {},
      };
      const response = convertInteractionToLlmResponse(interaction as any);
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
      const response = convertInteractionToLlmResponse(interaction as any);
      expect(response.turnComplete).toBe(true);
      expect(response.finishReason).toBe('STOP');
    });
  });

  describe('convertInteractionEventToLlmResponse', () => {
    it('should handle step.delta text event', () => {
      const event = {
        event_type: 'step.delta',
        delta: {
          type: 'text',
          text: 'hello',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event as any,
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

    it('should handle step.start, step.delta (arguments), and step.stop sequence for function call', () => {
      const aggregatedParts: Part[] = [];

      // 1. Step Start
      const startEvent = {
        event_type: 'step.start',
        step: {
          type: 'function_call',
          id: 'call-1',
          name: 'my_tool',
        },
      };
      let response = convertInteractionEventToLlmResponse(
        startEvent as any,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
      expect(aggregatedParts.length).toBe(1);
      expect(aggregatedParts[0].functionCall).toEqual({
        id: 'call-1',
        name: 'my_tool',
        args: {},
      });
      expect(aggregatedParts[0].partMetadata).toEqual({
        accumulatedArgs: '',
        isComplete: false,
      });

      // 2. Step Delta (arguments chunk 1)
      const deltaEvent1 = {
        event_type: 'step.delta',
        delta: {
          type: 'arguments_delta',
          arguments: '{"x":',
        },
      };
      response = convertInteractionEventToLlmResponse(
        deltaEvent1 as any,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
      expect(aggregatedParts[0].partMetadata?.accumulatedArgs).toBe('{"x":');

      // 3. Step Delta (arguments chunk 2)
      const deltaEvent2 = {
        event_type: 'step.delta',
        delta: {
          type: 'arguments_delta',
          arguments: ' 1}',
        },
      };
      response = convertInteractionEventToLlmResponse(
        deltaEvent2 as any,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
      expect(aggregatedParts[0].partMetadata?.accumulatedArgs).toBe('{"x": 1}');

      // 4. Step Stop
      const stopEvent = {
        event_type: 'step.stop',
      };
      response = convertInteractionEventToLlmResponse(
        stopEvent as any,
        aggregatedParts,
        'int-1',
      );

      expect(response).toEqual({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'my_tool',
                args: {x: 1},
              },
            },
          ],
        },
        partial: false,
        turnComplete: false,
        interactionId: 'int-1',
      });
      expect(aggregatedParts[0].partMetadata).toBeUndefined(); // metadata should be cleaned up
      expect(aggregatedParts[0].functionCall?.args).toEqual({x: 1});
    });

    it('should handle step.start thought event', () => {
      const aggregatedParts: Part[] = [];
      const event = {
        event_type: 'step.start',
        step: {
          type: 'thought',
          signature: 'sig-123',
        },
      };
      const response = convertInteractionEventToLlmResponse(
        event as any,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
      expect(aggregatedParts).toEqual([
        {
          thought: true,
          thoughtSignature: 'sig-123',
          partMetadata: {
            isComplete: false,
          },
        },
      ]);
    });

    it('should handle interaction.status_update completed event', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'completed',
      };
      const aggregatedParts: Part[] = [{text: 'final text'}];
      const response = convertInteractionEventToLlmResponse(
        event as any,
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
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'Mocked static response'}],
          },
        ],
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
            type: 'user_input',
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
          event_type: 'step.start',
          step: {
            type: 'model_output',
            content: [],
          },
          interaction_id: 'int-stream',
        },
        {
          event_type: 'step.delta',
          delta: {type: 'text', text: 'Part 1'},
        },
        {
          event_type: 'step.delta',
          delta: {type: 'text', text: 'Part 2'},
        },
        {
          event_type: 'step.stop',
        },
        {
          event_type: 'interaction.completed',
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
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'Mocked response'}],
          },
        ],
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
            type: 'user_input',
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
          event_type: 'step.start',
          step: {
            type: 'model_output',
            content: [],
          },
        },
        {
          event_type: 'step.delta',
          delta: {type: 'text', text: 'Stream text'},
          interaction_id: 'int-from-event',
        },
        {
          event_type: 'step.stop',
        },
        {
          event_type: 'interaction.completed',
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
        interactionId: 'int-from-event',
      });

      expect(responses[1].interactionId).toBe('int-from-event');
      expect(responses[1].turnComplete).toBe(true);

      expect(responses[2].interactionId).toBe('int-from-event');
    });

    it('should pass all generation config parameters', async () => {
      const mockInteraction = {
        id: 'int-999',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [{type: 'text', text: 'Mocked response'}],
          },
        ],
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
            type: 'user_input',
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
            event_type: 'step.start',
            step: {
              type: 'model_output',
              content: [],
            },
          };
          yield {
            event_type: 'step.delta',
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
            type: 'user_input',
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

  describe('convertStepToParts', () => {
    it('should return empty array for empty or invalid step', () => {
      expect(convertStepToParts(null as any)).toEqual([]);
      expect(convertStepToParts({} as any)).toEqual([]);
      expect(convertStepToParts({type: 'invalid'} as any)).toEqual([]);
    });

    it('should convert model_output step with text content', () => {
      const step = {
        type: 'model_output',
        content: [{type: 'text', text: 'hello'}],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          text: 'hello',
        },
      ]);
    });

    it('should convert model_output step with text content missing text', () => {
      const step = {
        type: 'model_output',
        content: [{type: 'text'}],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          text: '',
        },
      ]);
    });

    it('should convert function_call step', () => {
      const step = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {a: 1},
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          functionCall: {
            id: 'call-1',
            name: 'my_tool',
            args: {a: 1},
          },
        },
      ]);
    });

    it('should convert function_call step with missing arguments', () => {
      const step = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          functionCall: {
            id: 'call-1',
            name: 'my_tool',
            args: {},
          },
        },
      ]);
    });

    it('should convert function_call step with signature', () => {
      const step = {
        type: 'function_call',
        id: 'call-1',
        name: 'my_tool',
        arguments: {a: 1},
        signature: 'sig-123',
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          functionCall: {
            id: 'call-1',
            name: 'my_tool',
            args: {a: 1},
          },
          thoughtSignature: 'sig-123',
        },
      ]);
    });

    it('should convert function_result step', () => {
      const step = {
        type: 'function_result',
        call_id: 'call-1',
        result: {res: 'ok'},
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          functionResponse: {
            id: 'call-1',
            name: '',
            response: {res: 'ok'},
          },
        },
      ]);
    });

    it('should convert model_output step with image content (data)', () => {
      const step = {
        type: 'model_output',
        content: [
          {
            type: 'image',
            data: 'base64data',
            mime_type: 'image/png',
          },
        ],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          inlineData: {
            data: 'base64data',
            mimeType: 'image/png',
          },
        },
      ]);
    });

    it('should convert model_output step with image content (uri)', () => {
      const step = {
        type: 'model_output',
        content: [
          {
            type: 'image',
            uri: 'gs://bucket/img.png',
            mime_type: 'image/png',
          },
        ],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          fileData: {
            fileUri: 'gs://bucket/img.png',
            mimeType: 'image/png',
          },
        },
      ]);
    });

    it('should convert model_output step with audio content (data)', () => {
      const step = {
        type: 'model_output',
        content: [
          {
            type: 'audio',
            data: 'base64data',
            mime_type: 'audio/mp3',
          },
        ],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          inlineData: {
            data: 'base64data',
            mimeType: 'audio/mp3',
          },
        },
      ]);
    });

    it('should convert model_output step with audio content (uri)', () => {
      const step = {
        type: 'model_output',
        content: [
          {
            type: 'audio',
            uri: 'gs://bucket/audio.mp3',
            mime_type: 'audio/mp3',
          },
        ],
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          fileData: {
            fileUri: 'gs://bucket/audio.mp3',
            mimeType: 'audio/mp3',
          },
        },
      ]);
    });

    it('should convert thought step', () => {
      const step = {
        type: 'thought',
        signature: 'sig-123',
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          thought: true,
          thoughtSignature: 'sig-123',
        },
      ]);
    });

    it('should convert code_execution_result step', () => {
      const step = {
        type: 'code_execution_result',
        result: 'output text',
        is_error: false,
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          codeExecutionResult: {
            output: 'output text',
            outcome: Outcome.OUTCOME_OK,
          },
        },
      ]);

      const stepError = {
        type: 'code_execution_result',
        result: 'error text',
        is_error: true,
      };
      expect(convertStepToParts(stepError as any)).toEqual([
        {
          codeExecutionResult: {
            output: 'error text',
            outcome: Outcome.OUTCOME_FAILED,
          },
        },
      ]);
    });

    it('should convert code_execution_result step with missing result', () => {
      const step = {
        type: 'code_execution_result',
        is_error: false,
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          codeExecutionResult: {
            output: '',
            outcome: Outcome.OUTCOME_OK,
          },
        },
      ]);
    });

    it('should convert code_execution_call step', () => {
      const step = {
        type: 'code_execution_call',
        arguments: {
          code: 'print(1)',
          language: 'PYTHON',
        },
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          executableCode: {
            code: 'print(1)',
            language: 'PYTHON',
          },
        },
      ]);
    });

    it('should convert code_execution_call step with missing arguments', () => {
      const step = {
        type: 'code_execution_call',
      };
      expect(convertStepToParts(step as any)).toEqual([
        {
          executableCode: {
            code: '',
            language: 'PYTHON',
          },
        },
      ]);
    });
  });

  describe('convertInteractionEventToLlmResponse extra cases', () => {
    it('should handle step.delta image event (data)', () => {
      const event = {
        event_type: 'step.delta',
        delta: {
          type: 'image',
          data: 'imgdata',
          mime_type: 'image/png',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event as any,
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

    it('should handle step.delta image event (uri)', () => {
      const event = {
        event_type: 'step.delta',
        delta: {
          type: 'image',
          uri: 'gs://img.png',
          mime_type: 'image/png',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event as any,
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
      const response = convertInteractionEventToLlmResponse(
        event as any,
        [],
        'int-1',
      );
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
      const response = convertInteractionEventToLlmResponse(
        event as any,
        [],
        'int-1',
      );
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
        event as any,
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
      const response = convertInteractionEventToLlmResponse(
        event as any,
        [],
        'int-1',
      );
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
      const response = convertInteractionEventToLlmResponse(
        event as any,
        [],
        'int-1',
      );
      expect(response).toEqual({
        errorCode: 'UNKNOWN_ERROR',
        errorMessage: 'Unknown error',
        turnComplete: true,
        interactionId: 'int-1',
      });
    });

    it('should return null if event.delta is missing in step.delta event', () => {
      const event = {
        event_type: 'step.delta',
      };
      expect(convertInteractionEventToLlmResponse(event as any, [])).toBeNull();
    });

    it('should handle step.delta thought_signature event', () => {
      // 1. Start the function call step
      const startEvent = {
        event_type: 'step.start',
        step: {
          type: 'function_call',
          id: 'call-1',
          name: 'my_tool',
        },
      };
      const aggregatedParts: Part[] = [];
      convertInteractionEventToLlmResponse(startEvent as any, aggregatedParts);

      expect(aggregatedParts.length).toBe(1);
      expect(aggregatedParts[0].functionCall).toBeDefined();
      expect(aggregatedParts[0].thoughtSignature).toBeUndefined();

      // 2. Stream the signature delta
      const deltaEvent = {
        event_type: 'step.delta',
        delta: {
          type: 'thought_signature',
          signature: 'my-signature-data',
        },
      };
      const response = convertInteractionEventToLlmResponse(
        deltaEvent as any,
        aggregatedParts,
        'int-1',
      );

      expect(response).toBeNull();
      expect(aggregatedParts[0].thoughtSignature).toBe('my-signature-data');
    });

    it('should handle event with camelCase eventType', () => {
      const event = {
        eventType: 'step.delta',
        delta: {
          type: 'text',
          text: 'camelText',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event as any,
        aggregatedParts,
        'int-1',
      );
      expect(response?.content?.parts?.[0]?.text).toBe('camelText');
    });

    it('should handle step.delta text event with missing text', () => {
      const event = {
        event_type: 'step.delta',
        delta: {
          type: 'text',
        },
      };
      const aggregatedParts: Part[] = [];
      const response = convertInteractionEventToLlmResponse(
        event as any,
        aggregatedParts,
        'int-1',
      );
      expect(response).toBeNull();
    });

    it('should handle interaction.status_update requires_action event', () => {
      const event = {
        event_type: 'interaction.status_update',
        status: 'requires_action',
      };
      const response = convertInteractionEventToLlmResponse(
        event as any,
        [],
        'int-1',
      );
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
      expect(convertInteractionEventToLlmResponse(event as any, [])).toBeNull();
    });
  });

  describe('convertContentToSteps', () => {
    it('should convert user Content with text parts to user_input step', () => {
      const content: Content = {
        role: 'user',
        parts: [{text: 'Hello'}, {text: 'World'}],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'user_input',
          content: [
            {type: 'text', text: 'Hello'},
            {type: 'text', text: 'World'},
          ],
        },
      ]);
    });

    it('should convert user Content with functionResponse to function_result step', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'my_tool',
              response: {result: 'ok'},
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_result',
          call_id: 'call-1',
          name: 'my_tool',
          result: {result: 'ok'},
        },
      ]);
    });

    it('should convert user Content with codeExecutionResult to code_execution_result step', () => {
      const content: Content = {
        role: 'user',
        parts: [
          {
            codeExecutionResult: {
              output: 'compiled output',
              outcome: Outcome.OUTCOME_OK,
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_result',
          call_id: '',
          result: 'compiled output',
          is_error: false,
        },
      ]);
    });

    it('should convert model Content with text parts to model_output step', () => {
      const content: Content = {
        role: 'model',
        parts: [{text: 'Hello'}],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'model_output',
          content: [{type: 'text', text: 'Hello'}],
        },
      ]);
    });

    it('should convert model Content with functionCall to function_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-1',
              name: 'my_tool',
              args: {a: 1},
            },
            thoughtSignature: 'sig-123',
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'function_call',
          id: 'call-1',
          name: 'my_tool',
          arguments: {a: 1},
          signature: 'sig-123',
        },
      ]);
    });

    it('should convert model Content with executableCode to code_execution_call step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            executableCode: {
              code: 'print(1)',
              language: Language.PYTHON,
            },
          },
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'code_execution_call',
          id: '',
          arguments: {
            code: 'print(1)',
            language: 'python',
          },
        },
      ]);
    });

    it('should convert model Content with thought to thought step', () => {
      const content: Content = {
        role: 'model',
        parts: [
          {
            thought: true,
            thoughtSignature: 'sig-123',
          } as any,
        ],
      };
      expect(convertContentToSteps(content)).toEqual([
        {
          type: 'thought',
          signature: 'sig-123',
        },
      ]);
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
    it('should handle streaming call with interaction.created event and extract interaction ID from interaction object', async () => {
      const mockEvents = [
        {
          event_type: 'interaction.created',
          interaction: {id: 'int-start-id'},
        },
        {
          event_type: 'step.start',
          step: {
            type: 'model_output',
            content: [],
          },
        },
        {
          event_type: 'step.delta',
          delta: {type: 'text', text: 'Stream text'},
        },
        {
          event_type: 'step.stop',
        },
        {
          event_type: 'interaction.completed',
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

      expect(responses.length).toBe(3); // delta, completed, end-of-generator

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
          event_type: 'step.start',
          step: {
            type: 'model_output',
            content: [],
          },
          interactionId: 'int-camel-case',
        },
        {
          event_type: 'step.delta',
          delta: {type: 'text', text: 'Reply'},
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
      expect(responses[0].interactionId).toBe('int-camel-case');
    });
  });
});
