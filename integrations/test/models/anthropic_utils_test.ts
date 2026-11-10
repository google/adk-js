/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {logger} from '@google/adk';
import {FinishReason, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  buildAnthropicThinkingParam,
  ClaudeRole,
  contentBlockToPart,
  contentToMessageParam,
  createAnthropicClient,
  createDirectAnthropicClient,
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

const {mockAnthropicCtor, mockAnthropicSdkState} = vi.hoisted(() => {
  const anthropicSdkState: {
    shouldFailImport: boolean;
    ctorError?: Error;
    credentials?: unknown;
  } = {
    shouldFailImport: false,
  };
  const anthropicCtorFn = vi.fn(function (
    this: {
      options?: unknown;
      apiKey?: string | null;
      authToken?: string | null;
      credentials?: unknown;
    },
    options: unknown,
  ) {
    if (anthropicSdkState.ctorError) {
      throw anthropicSdkState.ctorError;
    }
    this.options = options;
    this.apiKey = process.env['ANTHROPIC_API_KEY'] || null;
    this.authToken = process.env['ANTHROPIC_AUTH_TOKEN'] || null;
    this.credentials = anthropicSdkState.credentials ?? null;
  });
  return {
    mockAnthropicCtor: anthropicCtorFn,
    mockAnthropicSdkState: anthropicSdkState,
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  get Anthropic() {
    if (mockAnthropicSdkState.shouldFailImport) {
      return undefined;
    }
    return mockAnthropicCtor;
  },
}));

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
  describe('buildAnthropicThinkingParam', () => {
    it('test_build_anthropic_thinking_param_with_config', () => {
      expect(
        buildAnthropicThinkingParam({
          thinkingConfig: {thinkingBudget: 5000},
        }),
      ).toEqual({
        type: 'enabled',
        budget_tokens: 5000,
      });
    });

    it('test_build_anthropic_thinking_param_zero_budget_disabled', () => {
      expect(
        buildAnthropicThinkingParam({
          thinkingConfig: {thinkingBudget: 0},
        }),
      ).toEqual({
        type: 'disabled',
      });
    });

    it('test_build_anthropic_thinking_param_none_budget_raises', () => {
      expect(() =>
        buildAnthropicThinkingParam({
          thinkingConfig: {},
        }),
      ).toThrow('thinkingBudget must be set explicitly');
    });

    it('test_build_anthropic_thinking_param_automatic_budget_uses_adaptive', () => {
      expect(
        buildAnthropicThinkingParam({
          thinkingConfig: {thinkingBudget: -1},
        }),
      ).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    });

    it('test_build_anthropic_thinking_param_other_negative_uses_adaptive', () => {
      expect(
        buildAnthropicThinkingParam({
          thinkingConfig: {thinkingBudget: -5},
        }),
      ).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    });

    it('test_build_anthropic_thinking_param_manual_budget_omits_display', () => {
      const result = buildAnthropicThinkingParam({
        thinkingConfig: {thinkingBudget: 2048},
      });
      expect(result).toBeDefined();
      expect('display' in (result ?? {})).toBe(false);
    });

    it('test_build_anthropic_thinking_param_no_config', () => {
      expect(buildAnthropicThinkingParam(undefined)).toBeUndefined();
      expect(
        buildAnthropicThinkingParam({systemInstruction: 'test'}),
      ).toBeUndefined();
    });
  });

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

    it('converts a thought part with text and no signature into a ThinkingBlockParam with an empty signature', () => {
      expect(
        partToMessageBlock({thought: true, text: 'internal reasoning'}),
      ).toEqual({
        type: 'thinking',
        thinking: 'internal reasoning',
        signature: '',
      });
    });

    it('test_part_to_message_block_thinking_roundtrip', () => {
      expect(
        partToMessageBlock({
          text: 'My reasoning steps.',
          thought: true,
          thoughtSignature: 'roundtrip_sig',
        }),
      ).toEqual({
        type: 'thinking',
        thinking: 'My reasoning steps.',
        signature: 'roundtrip_sig',
      });
    });

    it('test_part_to_message_block_redacted_thinking_roundtrip', () => {
      expect(
        partToMessageBlock({
          thought: true,
          thoughtSignature: 'encrypted_blob',
        }),
      ).toEqual({
        type: 'redacted_thinking',
        data: 'encrypted_blob',
      });
    });

    it('throws for a part that carries only a thoughtSignature', () => {
      expect(() => partToMessageBlock({thoughtSignature: 'sig'})).toThrow(
        'Part kind "thoughtSignature" is not supported by Claude.',
      );
    });

    it('throws a descriptive error for unsupported part kinds', () => {
      expect(() => partToMessageBlock({thought: true})).toThrow(
        'Part kind "thought" is not supported by Claude.',
      );

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

    it('test_content_to_message_param_drops_content_free_signature', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const message = contentToMessageParam({
          role: 'model',
          parts: [
            {text: '', thoughtSignature: 'sig_bin'},
            {thoughtSignature: 'AY89a18D'},
            {text: 'hello'},
          ],
        });

        expect(message).toEqual({
          role: 'assistant',
          content: [{type: 'text', text: 'hello'}],
        });
        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledWith(
          'Dropping a thought signature from another model.',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('test_content_to_message_param_keeps_signature_on_real_content', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const message = contentToMessageParam({
          role: 'model',
          parts: [
            {
              functionCall: {id: 'c1', name: 'do_it', args: {}},
              thoughtSignature: 'sig_1',
            },
            {text: 'hi', thought: true, thoughtSignature: 'sig'},
            {thought: true, thoughtSignature: 'opaque'},
            {thoughtSignature: 'gone', partMetadata: {a: 1}},
          ],
        });

        expect(message).toEqual({
          role: 'assistant',
          content: [
            {type: 'tool_use', id: 'c1', name: 'do_it', input: {}},
            {type: 'thinking', thinking: 'hi', signature: 'sig'},
            {type: 'redacted_thinking', data: 'opaque'},
          ],
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('test_content_to_message_param_skips_empty_text_part', () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      try {
        const result = contentToMessageParam({
          role: 'user',
          parts: [{text: 'run it'}, {text: ''}],
        });

        expect(result).toEqual({
          role: 'user',
          content: [{type: 'text', text: 'run it'}],
        });
        expect(debugSpy).toHaveBeenCalledWith(
          'Skipping empty text part for Claude request.',
        );
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('test_content_to_message_param_skips_empty_text_part_with_metadata', () => {
      const result = contentToMessageParam({
        role: 'user',
        parts: [{text: 'run it'}, {text: '', partMetadata: {key: 'value'}}],
      });

      expect(result).toEqual({
        role: 'user',
        content: [{type: 'text', text: 'run it'}],
      });
    });

    it('test_content_to_message_param_keeps_non_text_payload_with_empty_text', () => {
      const result = contentToMessageParam({
        role: 'model',
        parts: [
          {
            text: '',
            functionCall: {id: 'call_1', name: 'tool', args: {}},
          },
        ],
      });

      expect(result).toEqual({
        role: 'assistant',
        content: [{type: 'tool_use', id: 'call_1', name: 'tool', input: {}}],
      });
    });

    it('test_content_to_message_param_lone_empty_text_emits_placeholder_block', () => {
      const result = contentToMessageParam({
        role: 'user',
        parts: [{text: ''}],
      });

      expect(result).toEqual({
        role: 'user',
        content: [{type: 'text', text: '.'}],
      });
    });

    it('test_content_to_message_param_model_empty_text_emits_no_placeholder', () => {
      const result = contentToMessageParam({
        role: 'model',
        parts: [{text: ''}],
      });

      expect(result).toEqual({
        role: 'assistant',
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
    it('test_content_block_to_part_thinking_block', () => {
      expect(
        contentBlockToPart({
          type: 'thinking',
          thinking: 'Let me reason about this.',
          signature: 'sig_abc123',
        }),
      ).toEqual({
        text: 'Let me reason about this.',
        thought: true,
        thoughtSignature: 'sig_abc123',
      });
    });

    it('omits thoughtSignature when a thinking ContentBlock has an empty signature', () => {
      expect(
        contentBlockToPart({
          type: 'thinking',
          thinking: 'Let me reason about this.',
          signature: '',
        }),
      ).toEqual({
        text: 'Let me reason about this.',
        thought: true,
      });
    });

    it('test_content_block_to_part_redacted_thinking', () => {
      const part = contentBlockToPart({
        type: 'redacted_thinking',
        data: 'redacted_data',
      });

      expect(part.thought).toBe(true);
      expect(part.text).toBeUndefined();
      expect(part.thoughtSignature).toBe('redacted_data');
    });

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
          type: 'container_upload',
          file_id: 'file_01',
        }),
      ).toThrow(
        'Content block type "container_upload" is not supported by Claude.',
      );
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

    it('test_message_to_generate_content_response_with_thinking', () => {
      const message = createSampleAnthropicMessage({
        id: 'msg_test_thinking',
        content: [
          {
            type: 'thinking',
            thinking: 'I need to think about this.',
            signature: 'sig_xyz',
          },
          {
            type: 'redacted_thinking',
            data: 'hidden',
          },
          {
            type: 'text',
            text: 'Here is my answer.',
            citations: null,
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
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

      const response = messageToGenerateContentResponse(message);
      const parts = response.content?.parts ?? [];
      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({
        text: 'I need to think about this.',
        thought: true,
        thoughtSignature: 'sig_xyz',
      });
      expect(parts[1]).toEqual({
        thought: true,
        thoughtSignature: 'hidden',
      });
      expect(parts[2]).toEqual({
        text: 'Here is my answer.',
      });
    });

    it('skips empty and whitespace-only text blocks when converting an Anthropic Message', () => {
      const message = createSampleAnthropicMessage({
        content: [
          {
            type: 'thinking',
            thinking: 'Reasoning step.',
            signature: 'sig_1',
          },
          {
            type: 'text',
            text: '\n\n',
            citations: null,
          },
          {
            type: 'text',
            text: '',
            citations: null,
          },
          {
            type: 'text',
            text: 'Final answer.',
            citations: null,
          },
        ],
      });

      const response = messageToGenerateContentResponse(message);
      expect(response.content?.parts).toEqual([
        {
          text: 'Reasoning step.',
          thought: true,
          thoughtSignature: 'sig_1',
        },
        {
          text: 'Final answer.',
        },
      ]);
    });

    it.each<[number, number | null, number, number | undefined]>([
      [100, 60, 40, 60],
      [20, 0, 20, 0],
      [20, null, 20, undefined],
      [20, 50, 0, 20],
    ])(
      'test_message_to_generate_content_response_splits_thinking_tokens (output=%d, thinking=%s)',
      (outputTokens, thinkingTokens, expectedCandidates, expectedThoughts) => {
        const message = createSampleAnthropicMessage({
          usage: {
            input_tokens: 10,
            output_tokens: outputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details:
              thinkingTokens === null
                ? null
                : {thinking_tokens: thinkingTokens},
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        });

        const response = messageToGenerateContentResponse(message);
        expect(response.usageMetadata?.candidatesTokenCount).toBe(
          expectedCandidates,
        );
        expect(response.usageMetadata?.thoughtsTokenCount).toBe(
          expectedThoughts,
        );
      },
    );

    it('test_message_to_generate_content_response_thinking_tokens_not_double_counted', () => {
      const message = createSampleAnthropicMessage({
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
          output_tokens_details: {thinking_tokens: 60},
          server_tool_use: null,
          service_tier: null,
          speed: null,
        },
      });

      const usageMetadata =
        messageToGenerateContentResponse(message).usageMetadata;
      expect(usageMetadata?.thoughtsTokenCount).toBe(60);
      expect(usageMetadata?.candidatesTokenCount).toBe(40);
      expect(usageMetadata?.totalTokenCount).toBe(110);
      expect(usageMetadata?.promptTokenCount).toBe(10);
      expect(
        (usageMetadata?.candidatesTokenCount ?? 0) +
          (usageMetadata?.thoughtsTokenCount ?? 0),
      ).toBe(100);
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

  describe('createDirectAnthropicClient', () => {
    beforeEach(() => {
      mockAnthropicCtor.mockClear();
      mockAnthropicSdkState.shouldFailImport = false;
      mockAnthropicSdkState.ctorError = undefined;
      mockAnthropicSdkState.credentials = undefined;
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('creates an Anthropic client when ANTHROPIC_API_KEY is set', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-api-key');

      const client = await createDirectAnthropicClient();

      expect(client.apiKey).toBe('placeholder-api-key');
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
      expect(mockAnthropicCtor).toHaveBeenCalledWith();
    });

    it('creates an Anthropic client when ANTHROPIC_AUTH_TOKEN is set', async () => {
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'placeholder-auth-token');

      const client = await createDirectAnthropicClient();

      expect(client.authToken).toBe('placeholder-auth-token');
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    });

    it('creates an Anthropic client when the SDK resolves credentials without env vars', async () => {
      const provider = {getAccessToken: vi.fn()};
      mockAnthropicSdkState.credentials = provider;

      const client = await createDirectAnthropicClient();

      expect(client.apiKey).toBeNull();
      expect(client.authToken).toBeNull();
      expect(client.credentials).toBe(provider);
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    });

    it('throws a credential error naming ANTHROPIC_API_KEY and Claude when no credential is resolved', async () => {
      await expect(createDirectAnthropicClient()).rejects.toThrow(
        'No Anthropic credential was found for AnthropicLlm. ' +
          'Set ANTHROPIC_API_KEY (for example, `export ANTHROPIC_API_KEY=<your-key>`), ' +
          'or use Claude to call Claude models on Vertex AI.',
      );
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    });

    it('throws a credential error that preserves cause when the Anthropic constructor throws', async () => {
      const sdkError = new Error('SDK credential resolution failed');
      mockAnthropicSdkState.ctorError = sdkError;

      await expect(createDirectAnthropicClient()).rejects.toMatchObject({
        message:
          'No Anthropic credential was found for AnthropicLlm. ' +
          'Set ANTHROPIC_API_KEY (for example, `export ANTHROPIC_API_KEY=<your-key>`), ' +
          'or use Claude to call Claude models on Vertex AI.',
        cause: sdkError,
      });
    });

    it('throws an installation error that keeps the cause when the Anthropic export is missing', async () => {
      mockAnthropicSdkState.shouldFailImport = true;

      await expect(createDirectAnthropicClient()).rejects.toMatchObject({
        message:
          "AnthropicLlm requires the optional '@anthropic-ai/sdk' package. " +
          'Install it with: npm install @anthropic-ai/sdk',
        cause: expect.any(Error),
      });
    });
  });

  describe('createDirectAnthropicClient when @anthropic-ai/sdk cannot be imported', () => {
    const moduleNotFound = new Error("Cannot find package '@anthropic-ai/sdk'");

    beforeEach(() => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-api-key');
      vi.resetModules();
      vi.doMock('@anthropic-ai/sdk', () => {
        throw moduleNotFound;
      });
    });

    afterEach(() => {
      vi.doUnmock('@anthropic-ai/sdk');
      vi.resetModules();
      vi.unstubAllEnvs();
    });

    it('throws an installation error that keeps the import failure as its cause', async () => {
      const utils = await import('../../src/models/anthropic_utils.js');

      await expect(utils.createDirectAnthropicClient()).rejects.toMatchObject({
        message:
          "AnthropicLlm requires the optional '@anthropic-ai/sdk' package. " +
          'Install it with: npm install @anthropic-ai/sdk',
        cause: expect.any(Error),
      });
    });
  });
});
