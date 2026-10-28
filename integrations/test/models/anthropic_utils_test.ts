/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {FinishReason, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  ClaudeRole,
  contentBlockToPart,
  contentToMessageParam,
  createAnthropicClient,
  functionDeclarationToToolParam,
  messageToGenerateContentResponse,
  partToMessageBlock,
  toClaudeRole,
  toGoogleGenaiFinishReason,
  ToolUseIdSanitizer,
} from '../../src/models/anthropic_utils.js';

const {mockAnthropicVertexCtor, mockImportState} = vi.hoisted(() => {
  const importState = {shouldFailImport: false};
  const ctorFn = vi.fn(function (this: {options?: unknown}, options: unknown) {
    this.options = options;
  });
  return {
    mockAnthropicVertexCtor: ctorFn,
    mockImportState: importState,
  };
});

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  get AnthropicVertex() {
    if (mockImportState.shouldFailImport) {
      return undefined;
    }
    return mockAnthropicVertexCtor;
  },
}));

function createSampleAnthropicMessage(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6@default',
    container: null,
    content: [{type: 'text', text: 'Hello from Claude!', citations: null}],
    diagnostics: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 15,
      output_tokens: 8,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    ...overrides,
  };
}

describe('Claude conversion helpers', () => {
  describe('toClaudeRole', () => {
    it('maps model and assistant roles to assistant', () => {
      expect(toClaudeRole('model')).toBe('assistant');
      expect(toClaudeRole('assistant')).toBe('assistant');
      expect(toClaudeRole('model')).toBe(ClaudeRole.ASSISTANT);
    });

    it('maps user and other roles to user', () => {
      expect(toClaudeRole('user')).toBe('user');
      expect(toClaudeRole(undefined)).toBe('user');
      expect(toClaudeRole('system')).toBe('user');
      expect(toClaudeRole('user')).toBe(ClaudeRole.USER);
    });
  });

  describe('toGoogleGenaiFinishReason', () => {
    it('maps end_turn, stop_sequence, tool_use, and pause_turn to STOP', () => {
      expect(toGoogleGenaiFinishReason('end_turn')).toBe(FinishReason.STOP);
      expect(toGoogleGenaiFinishReason('stop_sequence')).toBe(
        FinishReason.STOP,
      );
      expect(toGoogleGenaiFinishReason('tool_use')).toBe(FinishReason.STOP);
      expect(toGoogleGenaiFinishReason('pause_turn')).toBe(FinishReason.STOP);
    });

    it('maps max_tokens and model_context_window_exceeded to MAX_TOKENS', () => {
      expect(toGoogleGenaiFinishReason('max_tokens')).toBe(
        FinishReason.MAX_TOKENS,
      );
      expect(toGoogleGenaiFinishReason('model_context_window_exceeded')).toBe(
        FinishReason.MAX_TOKENS,
      );
    });

    it('maps refusal to SAFETY', () => {
      expect(toGoogleGenaiFinishReason('refusal')).toBe(FinishReason.SAFETY);
    });

    it('maps unknown or null stop reasons to FINISH_REASON_UNSPECIFIED', () => {
      expect(toGoogleGenaiFinishReason(null)).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
      expect(toGoogleGenaiFinishReason(undefined)).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
      expect(toGoogleGenaiFinishReason('unknown_reason')).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
    });

    it.each<[Anthropic.StopReason | string | null | undefined, FinishReason]>([
      ['end_turn', FinishReason.STOP],
      ['stop_sequence', FinishReason.STOP],
      ['tool_use', FinishReason.STOP],
      ['pause_turn', FinishReason.STOP],
      ['max_tokens', FinishReason.MAX_TOKENS],
      ['model_context_window_exceeded', FinishReason.MAX_TOKENS],
      ['refusal', FinishReason.SAFETY],
      ['unknown', FinishReason.FINISH_REASON_UNSPECIFIED],
      [null, FinishReason.FINISH_REASON_UNSPECIFIED],
      [undefined, FinishReason.FINISH_REASON_UNSPECIFIED],
    ])(
      'test_to_google_genai_finish_reason (%s)',
      (stopReason, expectedFinishReason) => {
        expect(toGoogleGenaiFinishReason(stopReason)).toBe(
          expectedFinishReason,
        );
      },
    );
  });

  describe('ToolUseIdSanitizer', () => {
    it('pairs multiple missing tool IDs with the same tool name in FIFO order', () => {
      const sanitizer = new ToolUseIdSanitizer();
      const call1 = partToMessageBlock(
        {functionCall: {name: 'get_weather', args: {city: 'Paris'}}},
        sanitizer,
      );
      const call2 = partToMessageBlock(
        {functionCall: {name: 'get_weather', args: {city: 'London'}}},
        sanitizer,
      );
      const result1 = partToMessageBlock(
        {
          functionResponse: {
            name: 'get_weather',
            response: {result: 'Sunny'},
          },
        },
        sanitizer,
      );
      const result2 = partToMessageBlock(
        {
          functionResponse: {
            name: 'get_weather',
            response: {result: 'Rainy'},
          },
        },
        sanitizer,
      );

      expect(call1).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'get_weather',
        input: {city: 'Paris'},
      });
      expect(call2).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_1',
        name: 'get_weather',
        input: {city: 'London'},
      });
      expect(result1).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_fallback_0',
        content: 'Sunny',
        is_error: false,
      });
      expect(result2).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_fallback_1',
        content: 'Rainy',
        is_error: false,
      });
    });

    it('pairs missing tool IDs by tool name when responses arrive out of order', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize(undefined, 'tool_a', true)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize(undefined, 'tool_b', true)).toBe(
        'toolu_fallback_1',
      );
      expect(sanitizer.sanitize(undefined, 'tool_b', false)).toBe(
        'toolu_fallback_1',
      );
      expect(sanitizer.sanitize(undefined, 'tool_a', false)).toBe(
        'toolu_fallback_0',
      );
    });

    it('falls back to FIFO order across unpaired calls when response toolName does not match', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize(undefined, 'tool_a', true)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize(undefined, 'other_tool', false)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize(undefined, 'tool_a', false)).toBe(
        'toolu_fallback_1',
      );
    });

    it('removes assigned ID from unpairedCallsList when a named response claims it', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize('', 'fetch_schema', true)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize('', 'execute_sql', true)).toBe(
        'toolu_fallback_1',
      );
      expect(sanitizer.sanitize('', 'fetch_schema', false)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize('', '', false)).toBe('toolu_fallback_1');
    });

    it('removes assigned ID from unpairedCallsByName when an anonymous response claims it', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize('', 'fetch_schema', true)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize('', 'fetch_schema', true)).toBe(
        'toolu_fallback_1',
      );
      expect(sanitizer.sanitize('', '', false)).toBe('toolu_fallback_0');
      expect(sanitizer.sanitize('', 'fetch_schema', false)).toBe(
        'toolu_fallback_1',
      );
    });

    it('maps an unmapped non-empty invalid ID on a response to a deterministic fallback ID', () => {
      const sanitizer = new ToolUseIdSanitizer();
      expect(sanitizer.sanitize('bad id!', 'tool_a', false)).toBe(
        'toolu_fallback_0',
      );
      expect(sanitizer.sanitize('bad id!', 'tool_a', false)).toBe(
        'toolu_fallback_0',
      );
    });
  });

  describe('partToMessageBlock', () => {
    it('converts a text part into a TextBlockParam', () => {
      expect(partToMessageBlock({text: 'Check status'})).toEqual({
        type: 'text',
        text: 'Check status',
      });
    });

    it('converts a functionCall part into a ToolUseBlockParam', () => {
      expect(
        partToMessageBlock({
          functionCall: {
            id: 'toolu_123',
            name: 'lookup_order',
            args: {orderId: 'ORD-42'},
          },
        }),
      ).toEqual({
        type: 'tool_use',
        id: 'toolu_123',
        name: 'lookup_order',
        input: {orderId: 'ORD-42'},
      });
    });

    it('assigns a fallback id and defaults missing functionCall args', () => {
      expect(
        partToMessageBlock({
          functionCall: {
            name: 'ping',
          },
        }),
      ).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'ping',
        input: {},
      });
    });

    it('preserves valid tool use IDs matching ^[a-zA-Z0-9_-]+$', () => {
      const validIds = ['toolu_01A09q90qw90lq917835lq9', 'adk-12345-abc_DEF'];
      for (const validId of validIds) {
        expect(
          partToMessageBlock({
            functionCall: {id: validId, name: 'test_tool', args: {}},
          }),
        ).toEqual({
          type: 'tool_use',
          id: validId,
          name: 'test_tool',
          input: {},
        });
        expect(
          partToMessageBlock({
            functionResponse: {
              id: validId,
              name: 'test_tool',
              response: {result: 'ok'},
            },
          }),
        ).toEqual({
          type: 'tool_result',
          tool_use_id: validId,
          content: 'ok',
          is_error: false,
        });
      }
    });

    it('sanitizes invalid or missing tool use IDs consistently across a shared ToolUseIdSanitizer', () => {
      const invalidIds: Array<string | undefined> = [
        'invalid id with spaces!',
        'another@invalid#id',
        '',
        undefined,
      ];
      const sanitizer = new ToolUseIdSanitizer();

      for (const [index, badId] of invalidIds.entries()) {
        const expectedFallback = `toolu_fallback_${index}`;
        const callBlock = partToMessageBlock(
          {
            functionCall: {id: badId, name: 'test_tool', args: {}},
          },
          sanitizer,
        );
        const resultBlock = partToMessageBlock(
          {
            functionResponse: {
              id: badId,
              name: 'test_tool',
              response: {result: 'ok'},
            },
          },
          sanitizer,
        );

        expect(callBlock).toEqual({
          type: 'tool_use',
          id: expectedFallback,
          name: 'test_tool',
          input: {},
        });
        expect(resultBlock).toEqual({
          type: 'tool_result',
          tool_use_id: expectedFallback,
          content: 'ok',
          is_error: false,
        });
      }
    });

    it('test_part_to_message_block_function_call_none_id', () => {
      const result = partToMessageBlock({
        functionCall: {
          id: undefined,
          name: 'test_tool',
          args: {key: 'value'},
        },
      });
      expect(result).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'test_tool',
        input: {key: 'value'},
      });
    });

    it('test_part_to_message_block_function_call_empty_id', () => {
      const result = partToMessageBlock({
        functionCall: {
          id: '',
          name: 'test_tool',
          args: {key: 'value'},
        },
      });
      expect(result).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'test_tool',
        input: {key: 'value'},
      });
    });

    it('test_part_to_message_block_function_call_invalid_chars_id', () => {
      const result = partToMessageBlock({
        functionCall: {
          id: 'invalid id with spaces!',
          name: 'test_tool',
          args: {key: 'value'},
        },
      });
      expect(result).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'test_tool',
        input: {key: 'value'},
      });
    });

    it('test_part_to_message_block_function_response_none_id', () => {
      const result = partToMessageBlock({
        functionResponse: {
          id: undefined,
          name: 'test_tool',
          response: {result: 'ok'},
        },
      });
      expect(result).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_fallback_0',
        content: 'ok',
        is_error: false,
      });
    });

    it('test_part_to_message_block_function_response_empty_id', () => {
      const result = partToMessageBlock({
        functionResponse: {
          id: '',
          name: 'test_tool',
          response: {result: 'ok'},
        },
      });
      expect(result).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_fallback_0',
        content: 'ok',
        is_error: false,
      });
    });

    it('throws when functionCall has no name', () => {
      expect(() =>
        partToMessageBlock({
          functionCall: {},
        }),
      ).toThrow('FunctionCall must have a name.');
    });

    it('passes a string functionResponse result through unchanged', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_123',
            name: 'lookup_order',
            response: {result: 'Order shipped'},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_123',
        content: 'Order shipped',
        is_error: false,
      });
    });

    it('serializes a non-string functionResponse result as JSON', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_456',
            name: 'calculate_totals',
            response: {result: {subtotal: 120, tax: 12, items: ['a', 'b']}},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_456',
        content: '{"subtotal":120,"tax":12,"items":["a","b"]}',
        is_error: false,
      });
    });

    it('returns an empty string when functionResponse result is null or undefined', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_null',
            name: 'noop',
            response: {result: null},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_null',
        content: '',
        is_error: false,
      });

      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_undef',
            name: 'noop',
            response: {result: undefined},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_undef',
        content: '',
        is_error: false,
      });
    });

    it('serializes the whole response object as JSON when it has no result key', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_789',
            name: 'get_weather',
            response: {city: 'Tokyo', tempC: 19},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_789',
        content: '{"city":"Tokyo","tempC":19}',
        is_error: false,
      });
    });

    it('returns an empty string when functionResponse.response is empty or undefined', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_empty',
            name: 'noop',
            response: {},
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_empty',
        content: '',
        is_error: false,
      });

      expect(
        partToMessageBlock({
          functionResponse: {
            name: 'noop',
          },
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_fallback_0',
        content: '',
        is_error: false,
      });
    });

    it('drops a thoughtSignature on a text part', () => {
      expect(partToMessageBlock({text: 'hi', thoughtSignature: 'sig'})).toEqual(
        {
          type: 'text',
          text: 'hi',
        },
      );
    });

    it('drops a thoughtSignature on a functionCall part', () => {
      expect(
        partToMessageBlock({
          functionCall: {name: 'x', args: {}},
          thoughtSignature: 'sig',
        }),
      ).toEqual({
        type: 'tool_use',
        id: 'toolu_fallback_0',
        name: 'x',
        input: {},
      });
    });

    it('drops a thoughtSignature on a functionResponse part', () => {
      expect(
        partToMessageBlock({
          functionResponse: {
            id: 'toolu_sig',
            name: 'x',
            response: {result: 'done'},
          },
          thoughtSignature: 'sig',
        }),
      ).toEqual({
        type: 'tool_result',
        tool_use_id: 'toolu_sig',
        content: 'done',
        is_error: false,
      });
    });

    it('throws for a part that carries only a thoughtSignature', () => {
      expect(() => partToMessageBlock({thoughtSignature: 'sig'})).toThrow(
        'Part kind "thoughtSignature" is not supported by Claude.',
      );
    });

    it('throws a descriptive error for unsupported part kinds', () => {
      expect(() =>
        partToMessageBlock({thought: true, text: 'internal reasoning'}),
      ).toThrow('Part kind "thought" is not supported by Claude.');

      expect(() =>
        partToMessageBlock({
          inlineData: {mimeType: 'image/png', data: 'aGVsbG8='},
        }),
      ).toThrow('Part kind "inlineData" is not supported by Claude.');

      expect(() =>
        partToMessageBlock({
          fileData: {
            mimeType: 'application/pdf',
            fileUri: 'gs://bucket/doc.pdf',
          },
        }),
      ).toThrow('Part kind "fileData" is not supported by Claude.');

      expect(() =>
        partToMessageBlock({
          executableCode: {code: 'print(1)', language: undefined},
        }),
      ).toThrow('Part kind "executableCode" is not supported by Claude.');

      expect(() =>
        partToMessageBlock({
          codeExecutionResult: {output: '1', outcome: undefined},
        }),
      ).toThrow('Part kind "codeExecutionResult" is not supported by Claude.');

      expect(() => partToMessageBlock({text: ''})).toThrow(
        'Part kind "empty text" is not supported by Claude.',
      );

      expect(() => partToMessageBlock({})).toThrow(
        'Part kind "empty part" is not supported by Claude.',
      );
    });
  });

  describe('contentToMessageParam', () => {
    it('converts a Content object with multiple parts into a MessageParam', () => {
      expect(
        contentToMessageParam({
          role: 'model',
          parts: [
            {text: 'Calling tool...'},
            {
              functionCall: {
                id: 'toolu_1',
                name: 'get_weather',
                args: {city: 'Berlin'},
              },
            },
          ],
        }),
      ).toEqual({
        role: 'assistant',
        content: [
          {type: 'text', text: 'Calling tool...'},
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'get_weather',
            input: {city: 'Berlin'},
          },
        ],
      });
    });

    it('handles a Content object without parts', () => {
      expect(contentToMessageParam({role: 'user'})).toEqual({
        role: 'user',
        content: [],
      });
    });

    it('forwards the provided ToolUseIdSanitizer across all parts in the content', () => {
      const sanitizer = new ToolUseIdSanitizer();
      const assistantMessage = contentToMessageParam(
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'bad id!',
                name: 'get_weather',
                args: {city: 'Rome'},
              },
            },
            {
              functionCall: {
                name: 'get_time',
                args: {city: 'Rome'},
              },
            },
          ],
        },
        sanitizer,
      );
      const userMessage = contentToMessageParam(
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_time',
                response: {result: '15:00'},
              },
            },
            {
              functionResponse: {
                id: 'bad id!',
                name: 'get_weather',
                response: {result: 'Warm'},
              },
            },
          ],
        },
        sanitizer,
      );

      expect(assistantMessage).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_fallback_0',
            name: 'get_weather',
            input: {city: 'Rome'},
          },
          {
            type: 'tool_use',
            id: 'toolu_fallback_1',
            name: 'get_time',
            input: {city: 'Rome'},
          },
        ],
      });
      expect(userMessage).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_fallback_1',
            content: '15:00',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_fallback_0',
            content: 'Warm',
            is_error: false,
          },
        ],
      });
    });
  });

  describe('contentBlockToPart', () => {
    it('converts a text ContentBlock to a text Part', () => {
      expect(
        contentBlockToPart({
          type: 'text',
          text: 'Here is the summary.',
          citations: null,
        }),
      ).toEqual({
        text: 'Here is the summary.',
      });
    });

    it('converts a tool_use ContentBlock to a functionCall Part', () => {
      expect(
        contentBlockToPart({
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'search_docs',
          input: {query: 'vertex claude'},
          caller: {type: 'direct'},
        }),
      ).toEqual({
        functionCall: {
          id: 'toolu_abc',
          name: 'search_docs',
          args: {query: 'vertex claude'},
        },
      });
    });

    it('throws when a tool_use block input is not a plain object', () => {
      expect(() =>
        contentBlockToPart({
          type: 'tool_use',
          id: 'toolu_bad',
          name: 'search_docs',
          input: ['not-an-object'],
          caller: {type: 'direct'},
        }),
      ).toThrow('ToolUseBlock input for "search_docs" must be a JSON object.');
    });

    it('throws for unsupported ContentBlock types', () => {
      expect(() =>
        contentBlockToPart({
          type: 'thinking',
          thinking: 'step by step',
          signature: 'sig_1',
        }),
      ).toThrow('Content block type "thinking" is not supported by Claude.');
    });
  });

  describe('messageToGenerateContentResponse', () => {
    it('converts an Anthropic Message into an LlmResponse with usage metadata', () => {
      const message = createSampleAnthropicMessage({
        content: [
          {type: 'text', text: 'Let me check that.', citations: null},
          {
            type: 'tool_use',
            id: 'toolu_99',
            name: 'get_forecast',
            input: {city: 'Paris'},
            caller: {type: 'direct'},
          },
        ],
        usage: {
          input_tokens: 42,
          output_tokens: 18,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
      });

      expect(messageToGenerateContentResponse(message)).toEqual({
        content: {
          role: 'model',
          parts: [
            {text: 'Let me check that.'},
            {
              functionCall: {
                id: 'toolu_99',
                name: 'get_forecast',
                args: {city: 'Paris'},
              },
            },
          ],
        },
        finishReason: FinishReason.STOP,
        usageMetadata: {
          promptTokenCount: 42,
          candidatesTokenCount: 18,
          totalTokenCount: 60,
        },
      });
    });

    it.each<[Anthropic.StopReason | null, FinishReason]>([
      ['end_turn', FinishReason.STOP],
      ['stop_sequence', FinishReason.STOP],
      ['tool_use', FinishReason.STOP],
      ['pause_turn', FinishReason.STOP],
      ['max_tokens', FinishReason.MAX_TOKENS],
      ['model_context_window_exceeded', FinishReason.MAX_TOKENS],
      ['refusal', FinishReason.SAFETY],
      [null, FinishReason.FINISH_REASON_UNSPECIFIED],
    ])(
      'test_message_to_generate_content_response_maps_finish_reason (%s)',
      (stopReason, expectedFinishReason) => {
        const message = createSampleAnthropicMessage({stop_reason: stopReason});
        const response = messageToGenerateContentResponse(message);
        expect(response.finishReason).toBe(expectedFinishReason);
      },
    );
  });

  describe('functionDeclarationToToolParam', () => {
    it('converts nested FunctionDeclaration.parameters via genaiSchemaToJsonSchema', () => {
      const tool = functionDeclarationToToolParam({
        name: 'create_shipment',
        description: 'Creates a shipment order.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            destination: {
              type: Type.OBJECT,
              description: 'Shipping destination.',
              properties: {
                city: {type: Type.STRING},
                postalCode: {type: Type.STRING},
              },
              required: ['city'],
            },
            tags: {
              type: Type.ARRAY,
              items: {type: Type.STRING},
            },
          },
          required: ['destination'],
        },
      });

      expect(tool).toEqual({
        name: 'create_shipment',
        description: 'Creates a shipment order.',
        input_schema: {
          type: 'object',
          properties: {
            destination: {
              type: 'object',
              description: 'Shipping destination.',
              properties: {
                city: {type: 'string'},
                postalCode: {type: 'string'},
              },
              required: ['city'],
            },
            tags: {
              type: 'array',
              items: {type: 'string'},
            },
          },
          required: ['destination'],
        },
      });
    });

    it('converts nullable properties and string-valued bounds into JSON Schema', () => {
      const tool = functionDeclarationToToolParam({
        name: 'tag_items',
        parameters: {
          type: Type.OBJECT,
          properties: {
            note: {type: Type.STRING, nullable: true, maxLength: '40'},
            tags: {
              type: Type.ARRAY,
              items: {type: Type.STRING},
              minItems: '1',
              maxItems: '5',
            },
          },
          required: ['tags'],
        },
      });

      expect(tool).toEqual({
        name: 'tag_items',
        description: '',
        input_schema: {
          type: 'object',
          properties: {
            note: {type: ['string', 'null'], maxLength: 40},
            tags: {
              type: 'array',
              items: {type: 'string'},
              minItems: 1,
              maxItems: 5,
            },
          },
          required: ['tags'],
        },
      });
    });

    it('passes parametersJsonSchema through with type set to object', () => {
      const rawJsonSchema = {
        type: 'object',
        properties: {
          query: {type: 'string', minLength: 1},
          filters: {
            type: 'object',
            properties: {limit: {type: 'integer'}},
          },
        },
        required: ['query'],
      };

      const tool = functionDeclarationToToolParam({
        name: 'search_catalog',
        description: 'Searches the product catalog.',
        parametersJsonSchema: rawJsonSchema,
      });

      expect(tool).toEqual({
        name: 'search_catalog',
        description: 'Searches the product catalog.',
        input_schema: rawJsonSchema,
      });
    });

    it('defaults to an empty object schema when no parameters are declared', () => {
      expect(
        functionDeclarationToToolParam({
          name: 'get_server_time',
        }),
      ).toEqual({
        name: 'get_server_time',
        description: '',
        input_schema: {
          type: 'object',
          properties: {},
        },
      });
    });

    it('throws when FunctionDeclaration has no name', () => {
      expect(() =>
        functionDeclarationToToolParam({
          description: 'Unnamed tool',
        }),
      ).toThrow('FunctionDeclaration must have a name.');
    });
  });

  describe('createAnthropicClient', () => {
    beforeEach(() => {
      mockAnthropicVertexCtor.mockClear();
      mockImportState.shouldFailImport = false;
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-gcp-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-east5');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('creates an AnthropicVertex client from GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION', async () => {
      const client = await createAnthropicClient();
      expect(client).toBeDefined();
      expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
      expect(mockAnthropicVertexCtor).toHaveBeenCalledWith({
        projectId: 'test-gcp-project',
        region: 'us-east5',
      });
    });

    it('throws when GOOGLE_CLOUD_PROJECT is unset', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
      await expect(createAnthropicClient()).rejects.toThrow(
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
      );
      expect(mockAnthropicVertexCtor).not.toHaveBeenCalled();
    });

    it.each([
      ['empty', ''],
      ['undefined', undefined],
    ])(
      'throws when only GOOGLE_CLOUD_LOCATION is %s',
      async (_label, location) => {
        vi.stubEnv('GOOGLE_CLOUD_LOCATION', location);
        await expect(createAnthropicClient()).rejects.toThrow(
          'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
        );
        expect(mockAnthropicVertexCtor).not.toHaveBeenCalled();
      },
    );

    it('throws an installation error that keeps the cause when the AnthropicVertex export is missing', async () => {
      mockImportState.shouldFailImport = true;
      await expect(createAnthropicClient()).rejects.toMatchObject({
        message: expect.stringContaining(
          'Install it with: npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk',
        ),
        cause: expect.any(Error),
      });
    });
  });

  describe('createAnthropicClient when @anthropic-ai/vertex-sdk cannot be imported', () => {
    const moduleNotFound = new Error(
      "Cannot find package '@anthropic-ai/vertex-sdk'",
    );

    beforeEach(() => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-gcp-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-east5');
      vi.resetModules();
      vi.doMock('@anthropic-ai/vertex-sdk', () => {
        throw moduleNotFound;
      });
    });

    afterEach(() => {
      vi.doUnmock('@anthropic-ai/vertex-sdk');
      vi.resetModules();
      vi.unstubAllEnvs();
    });

    it('throws an installation error that keeps the import failure as its cause', async () => {
      const utils = await import('../../src/models/anthropic_utils.js');

      await expect(utils.createAnthropicClient()).rejects.toMatchObject({
        message:
          "Claude requires the optional '@anthropic-ai/vertex-sdk' package. " +
          'Install it with: npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk',
        cause: expect.any(Error),
      });
    });
  });
});
