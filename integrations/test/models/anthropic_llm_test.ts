/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {
  BaseLlm,
  FunctionTool,
  LLMRegistry,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {Claude, isClaude} from '@google/adk-integrations';
import {FinishReason, Type} from '@google/genai';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {MAX_TOKEN} from '../../src/models/anthropic_llm.js';

const {mockMessagesCreate, mockAnthropicVertexCtor, mockImportState} =
  vi.hoisted(() => {
    const createFn =
      vi.fn<
        (
          body: Anthropic.MessageCreateParamsNonStreaming,
          options?: Anthropic.RequestOptions,
        ) => Promise<Anthropic.Message>
      >();
    const importState = {shouldFailImport: false};
    const ctorFn = vi.fn(function (
      this: {options?: unknown; messages?: {create: typeof createFn}},
      options: unknown,
    ) {
      this.options = options;
      this.messages = {
        create: createFn,
      };
    });
    return {
      mockMessagesCreate: createFn,
      mockAnthropicVertexCtor: ctorFn,
      mockImportState: importState,
    };
  });

function extractSentToolIds(): {useIds: string[]; resultIds: string[]} {
  const sentMessages = mockMessagesCreate.mock.calls[0]?.[0]?.messages ?? [];
  const useIds: string[] = [];
  const resultIds: string[] = [];
  for (const message of sentMessages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        useIds.push(block.id);
      } else if (block.type === 'tool_result') {
        resultIds.push(block.tool_use_id);
      }
    }
  }
  return {useIds, resultIds};
}

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

describe('test_match_claude_family', () => {
  beforeAll(() => {
    LLMRegistry.register(Claude);
  });

  const supportedModelNames = [
    'claude-3-5-haiku@20241022',
    'claude-3-5-sonnet-v2@20241022',
    'claude-3-5-sonnet@20240620',
    'claude-3-haiku@20240307',
    'claude-3-opus@20240229',
    'claude-3-sonnet@20240229',
    'claude-sonnet-4@20250514',
    'claude-opus-4@20250514',
    'claude-haiku-4-5',
    'claude-haiku-4-5@20251001',
    'claude-haiku-5-5@default',
    'claude-sonnet-4-6@default',
    'claude-opus-4-6@default',
    'claude-opus-4-7@default',
    'claude-opus-4-8@default',
    'claude-opus-5@default',
  ];

  it.each(supportedModelNames)('test_match_claude_family (%s)', (modelName) => {
    expect(LLMRegistry.resolve(modelName)).toBe(Claude);
  });

  it('instantiates Claude via LLMRegistry.newLlm', () => {
    const llm = LLMRegistry.newLlm('claude-sonnet-4-6@default');
    expect(llm).toBeInstanceOf(Claude);
    expect(llm.model).toBe('claude-sonnet-4-6@default');
  });
});

describe('Claude', () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAnthropicVertexCtor.mockClear();
    mockImportState.shouldFailImport = false;
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-gcp-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-east5');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses claude-sonnet-4-6@default and 8192 maxTokens when no options are specified', () => {
    const llm = new Claude();
    expect(llm.model).toBe('claude-sonnet-4-6@default');
    expect(llm.maxTokens).toBe(8192);
    expect(MAX_TOKEN).toBe(1024);
  });

  it('accepts a custom model identifier and custom maxTokens', () => {
    const llm = new Claude({
      model: 'claude-opus-4-7@default',
      maxTokens: 4096,
    });
    expect(llm.model).toBe('claude-opus-4-7@default');
    expect(llm.maxTokens).toBe(4096);
  });

  it('identifies Claude instances via isClaude', () => {
    const claude = new Claude();
    expect(isClaude(claude)).toBe(true);
    expect(isClaude({})).toBe(false);
    expect(isClaude(null)).toBe(false);
    expect(isClaude('claude-sonnet-4-6@default')).toBe(false);

    class OtherLlm extends BaseLlm {
      constructor() {
        super({model: 'other'});
      }
      override async *generateContentAsync(): AsyncGenerator<
        LlmResponse,
        void
      > {}
      override async connect(): Promise<never> {
        throw new Error('not supported');
      }
    }
    expect(isClaude(new OtherLlm())).toBe(false);
  });

  it('rejects connect() because live connections are not supported', async () => {
    const llm = new Claude();
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await expect(llm.connect(request)).rejects.toThrow(
      'Live connection is not supported for claude-sonnet-4-6@default.',
    );
  });

  it('builds the Vertex AI request across all config.tools entries and yields a single response', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const abortController = new AbortController();
    const request: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'What is the weather and time in Paris?'}],
        },
      ],
      config: {
        systemInstruction: 'You are a concise travel assistant.',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Gets weather by city.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {city: {type: Type.STRING}},
                  required: ['city'],
                },
              },
            ],
          },
          {
            functionDeclarations: [
              {
                name: 'get_time',
                description: 'Gets local time by city.',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {city: {type: 'string'}},
                  required: ['city'],
                },
              },
            ],
          },
        ],
      },
      liveConnectConfig: {},
      toolsDict: {
        get_weather: new FunctionTool({
          name: 'get_weather',
          description: 'Gets weather by city.',
          execute: () => 'sunny',
        }),
        get_time: new FunctionTool({
          name: 'get_time',
          description: 'Gets local time by city.',
          execute: () => '12:00',
        }),
      },
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(
      request,
      true,
      abortController.signal,
    )) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]?.partial).toBeUndefined();
    expect(responses[0]).toEqual({
      content: {
        role: 'model',
        parts: [{text: 'Hello from Claude!'}],
      },
      finishReason: FinishReason.STOP,
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
      },
    });

    expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledWith({
      projectId: 'test-gcp-project',
      region: 'us-east5',
    });

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      {
        model: 'claude-sonnet-4-6@default',
        system: 'You are a concise travel assistant.',
        messages: [
          {
            role: 'user',
            content: [
              {type: 'text', text: 'What is the weather and time in Paris?'},
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Gets weather by city.',
            input_schema: {
              type: 'object',
              properties: {city: {type: 'string'}},
              required: ['city'],
            },
          },
          {
            name: 'get_time',
            description: 'Gets local time by city.',
            input_schema: {
              type: 'object',
              properties: {city: {type: 'string'}},
              required: ['city'],
            },
          },
        ],
        tool_choice: {
          type: 'auto',
          disable_parallel_tool_use: true,
        },
        max_tokens: 8192,
      },
      {signal: abortController.signal},
    );
  });

  it('extracts system instruction text from a Content object and omits tool_choice when toolsDict is empty', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude({model: 'claude-haiku-4-5@20251001'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {
        systemInstruction: {
          role: 'system',
          parts: [{text: 'First rule.'}, {text: 'Second rule.'}],
        },
      },
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request, false)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      {
        model: 'claude-haiku-4-5@20251001',
        system: 'First rule.\nSecond rule.',
        messages: [{role: 'user', content: [{type: 'text', text: 'Hello'}]}],
        tools: undefined,
        tool_choice: undefined,
        max_tokens: 8192,
      },
      undefined,
    );
  });

  it('test_generate_content_async_with_max_tokens', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude({maxTokens: 4096});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 4096,
      }),
      undefined,
    );
  });

  it('overrides constructor maxTokens when llmRequest.config.maxOutputTokens is set', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude({maxTokens: 4096});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {
        maxOutputTokens: 2048,
      },
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 2048,
      }),
      undefined,
    );
  });

  it.each<[Anthropic.StopReason, FinishReason]>([
    ['end_turn', FinishReason.STOP],
    ['max_tokens', FinishReason.MAX_TOKENS],
    ['refusal', FinishReason.SAFETY],
  ])(
    'test_non_streaming_sets_finish_reason (%s)',
    async (stopReason, expectedFinishReason) => {
      mockMessagesCreate.mockResolvedValue(
        createSampleAnthropicMessage({stop_reason: stopReason}),
      );

      const llm = new Claude();
      const request: LlmRequest = {
        contents: [{role: 'user', parts: [{text: 'Hi'}]}],
        config: {systemInstruction: 'Test'},
        liveConnectConfig: {},
        toolsDict: {},
      };

      const responses: LlmResponse[] = [];
      for await (const response of llm.generateContentAsync(request, false)) {
        responses.push(response);
      }

      expect(responses).toHaveLength(1);
      expect(responses[0]?.finishReason).toBe(expectedFinishReason);
    },
  );

  it('sanitizes and pairs invalid or missing tool use IDs across messages in a single request', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [
        {
          role: 'user',
          parts: [{text: 'Check weather and time'}],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'bad id 1',
                name: 'get_weather',
                args: {city: 'Paris'},
              },
            },
            {
              functionCall: {
                name: 'get_time',
                args: {city: 'Paris'},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'get_time',
                response: {result: '14:00'},
              },
            },
            {
              functionResponse: {
                id: 'bad id 1',
                name: 'get_weather',
                response: {result: 'Sunny'},
              },
            },
          ],
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume first response
    }

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Check weather and time'}],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_fallback_0',
                name: 'get_weather',
                input: {city: 'Paris'},
              },
              {
                type: 'tool_use',
                id: 'toolu_fallback_1',
                name: 'get_time',
                input: {city: 'Paris'},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_fallback_1',
                content: '14:00',
                is_error: false,
              },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_fallback_0',
                content: 'Sunny',
                is_error: false,
              },
            ],
          },
        ],
      }),
      undefined,
    );
  });

  it.each<
    [string, Array<string | undefined>, Array<string | undefined>, number]
  >([
    [
      'distinct_invalid_pair_uniquely',
      ['bad A!', 'bad B!'],
      ['bad A!', 'bad B!'],
      2,
    ],
    ['matching_empty_ids_pair', [''], [''], 1],
    ['multiple_empty_ids_pair_distinctly', ['', ''], ['', ''], 2],
    [
      'multiple_none_ids_pair_distinctly',
      [undefined, undefined],
      [undefined, undefined],
      2,
    ],
    ['none_and_empty_collapse', [undefined], [''], 1],
    ['repeated_invalid_id_consistent', ['bad!'], ['bad!'], 1],
  ])(
    'test_generate_content_async_pairs_invalid_tool_ids (%s)',
    async (_caseId, callIds, responseIds, expectedUnique) => {
      mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

      const llm = new Claude();
      const request: LlmRequest = {
        contents: [
          {role: 'user', parts: [{text: 'Hi'}]},
          {
            role: 'model',
            parts: callIds.map((id, i) => ({
              functionCall: {
                id,
                name: `tool_${i}`,
                args: {},
              },
            })),
          },
          {
            role: 'user',
            parts: responseIds.map((id, i) => ({
              functionResponse: {
                id,
                name: `tool_${i}`,
                response: {result: 'ok'},
              },
            })),
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };

      for await (const _ of llm.generateContentAsync(request)) {
        // consume response
      }

      const {useIds, resultIds} = extractSentToolIds();
      expect(new Set(useIds).size).toBe(expectedUnique);
      expect(new Set(useIds)).toEqual(new Set(resultIds));
      expect(useIds).toEqual(resultIds);
    },
  );

  it('test_generate_content_async_multiturn_empty_tool_ids_unique', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'Question 1'}]},
        {
          role: 'model',
          parts: [{functionCall: {id: '', name: 'execute_sql', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: '',
                name: 'execute_sql',
                response: {result: 'ok'},
              },
            },
          ],
        },
        {role: 'user', parts: [{text: 'Question 2'}]},
        {
          role: 'model',
          parts: [{functionCall: {id: '', name: 'execute_sql', args: {}}}],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: '',
                name: 'execute_sql',
                response: {result: 'ok'},
              },
            },
          ],
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    const {useIds, resultIds} = extractSentToolIds();
    expect(useIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(resultIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(new Set(useIds).size).toBe(2);
    expect(useIds).toEqual(resultIds);
  });

  it('test_generate_content_async_named_response_removes_from_fallback_list', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'Question 1'}]},
        {
          role: 'model',
          parts: [
            {functionCall: {id: '', name: 'fetch_schema', args: {}}},
            {functionCall: {id: '', name: 'execute_sql', args: {}}},
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: '',
                name: 'fetch_schema',
                response: {result: 'ok'},
              },
            },
            {
              functionResponse: {
                id: '',
                name: '',
                response: {result: 'ok'},
              },
            },
          ],
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    const {useIds, resultIds} = extractSentToolIds();
    expect(useIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(resultIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(new Set(useIds).size).toBe(2);
    expect(new Set(resultIds).size).toBe(2);
    expect(useIds).toEqual(resultIds);
  });

  it('test_generate_content_async_anonymous_response_removes_from_named_map', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'Question 1'}]},
        {
          role: 'model',
          parts: [
            {functionCall: {id: '', name: 'fetch_schema', args: {}}},
            {functionCall: {id: '', name: 'fetch_schema', args: {}}},
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: '',
                name: '',
                response: {result: 'ok'},
              },
            },
            {
              functionResponse: {
                id: '',
                name: 'fetch_schema',
                response: {result: 'ok'},
              },
            },
          ],
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    const {useIds, resultIds} = extractSentToolIds();
    expect(useIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(resultIds).toEqual(['toolu_fallback_0', 'toolu_fallback_1']);
    expect(new Set(useIds).size).toBe(2);
    expect(new Set(resultIds).size).toBe(2);
    expect(useIds).toEqual(resultIds);
  });

  it('caches the AnthropicVertex client across calls on the same Claude instance', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'First'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume first call
    }
    for await (const _ of llm.generateContentAsync(request)) {
      // consume second call
    }

    expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('throws when GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION is missing', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );
  });

  it('retries client creation after a failed first call on the same instance', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );
    expect(mockAnthropicVertexCtor).not.toHaveBeenCalled();

    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'global');
    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledWith({
      projectId: 'test-gcp-project',
      region: 'global',
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('throws an installation error when @anthropic-ai/vertex-sdk is unavailable', async () => {
    mockImportState.shouldFailImport = true;

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toThrow(
      'Install it with: npm install @anthropic-ai/sdk @anthropic-ai/vertex-sdk',
    );
  });
});
