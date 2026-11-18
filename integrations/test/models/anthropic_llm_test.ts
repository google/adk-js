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
  logger,
} from '@google/adk';
import {
  AnthropicLlm,
  type AnthropicLlmParams,
  Claude,
  isAnthropicLlm,
  isClaude,
  MAX_TOKEN,
} from '@google/adk-integrations';
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
      messages?: {create: typeof mockMessagesCreate};
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
    this.messages = {
      create: mockMessagesCreate,
    };
  });
  return {
    mockAnthropicCtor: anthropicCtorFn,
    mockAnthropicSdkState: anthropicSdkState,
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

describe('Claude model family matching', () => {
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

  it.each(supportedModelNames)(
    'resolves %s to Claude in LLMRegistry',
    (modelName) => {
      expect(LLMRegistry.resolve(modelName)).toBe(Claude);
    },
  );

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

  it('passes constructor maxTokens as max_tokens in the Anthropic request', async () => {
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
    'maps Anthropic stop_reason %s to FinishReason in non-streaming responses',
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
      'distinct invalid IDs pair uniquely',
      ['bad A!', 'bad B!'],
      ['bad A!', 'bad B!'],
      2,
    ],
    ['matching empty IDs pair', [''], [''], 1],
    ['multiple empty IDs pair distinctly', ['', ''], ['', ''], 2],
    [
      'multiple undefined IDs pair distinctly',
      [undefined, undefined],
      [undefined, undefined],
      2,
    ],
    ['undefined and empty IDs collapse', [undefined], [''], 1],
    ['repeated invalid IDs stay consistent', ['bad!'], ['bad!'], 1],
  ])(
    'pairs sanitized fallback tool IDs across call and response parts (%s)',
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

  it('assigns unique fallback tool IDs to empty IDs across multi-turn requests', async () => {
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

  it('removes a named tool response from the fallback queue so a subsequent unnamed response gets the remaining ID', async () => {
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

  it('removes an unnamed tool response from the named map so a subsequent named response gets the remaining ID', async () => {
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

  it('creates an AnthropicVertex client from GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');

    const llm = new Claude({model: 'claude-sonnet-4-6@default'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume response
    }

    expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledWith({
      projectId: 'env-project',
      region: 'env-location',
    });
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });

  it('exposes the supported Claude model regex pattern on supportedModels', () => {
    expect(Claude.supportedModels).toEqual([/claude-.*/]);
    expect(AnthropicLlm.supportedModels).toEqual([/claude-.*/]);
  });

  it('generates a non-streaming response from Claude for a text prompt', async () => {
    mockMessagesCreate.mockResolvedValue(
      createSampleAnthropicMessage({
        content: [
          {
            type: 'text',
            text: 'Hello, how can I help you?',
            citations: null,
          },
        ],
      }),
    );

    const llm = new Claude({model: 'claude-sonnet-4-6@default'});
    const request: LlmRequest = {
      model: 'claude-sonnet-4-6@default',
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {systemInstruction: 'You are a helpful assistant'},
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request, false)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]?.content?.parts?.[0]?.text).toBe(
      'Hello, how can I help you?',
    );
  });

  it('explains the direct AnthropicLlm alternative when Vertex AI env vars are missing', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');

    const llm = new Claude({model: 'claude-sonnet-4-6@default'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    let thrownError: unknown;
    try {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    } catch (err: unknown) {
      thrownError = err;
    }

    if (!(thrownError instanceof Error)) {
      throw new Error('Expected generateContentAsync to reject with an Error.');
    }
    expect(thrownError.message).toContain('GOOGLE_CLOUD_PROJECT');
    expect(thrownError.message).toContain('GOOGLE_CLOUD_LOCATION');
    expect(thrownError.message).toContain('Vertex');
    expect(thrownError.message).toContain('Anthropic API');
    expect(thrownError.message).toContain('ANTHROPIC_API_KEY');
    expect(thrownError.message).toContain('AnthropicLlm');
  });

  it('succeeds when @anthropic-ai/sdk fails to import because Claude only loads @anthropic-ai/vertex-sdk', async () => {
    mockAnthropicSdkState.shouldFailImport = true;
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new Claude();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor).not.toHaveBeenCalled();
  });
});

describe('AnthropicLlm', () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAnthropicCtor.mockClear();
    mockAnthropicVertexCtor.mockClear();
    mockImportState.shouldFailImport = false;
    mockAnthropicSdkState.shouldFailImport = false;
    mockAnthropicSdkState.ctorError = undefined;
    mockAnthropicSdkState.credentials = undefined;
    vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-not-a-real-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses claude-sonnet-5-5 and 8192 maxTokens when no options are specified', () => {
    const llm = new AnthropicLlm();
    expect(llm.model).toBe('claude-sonnet-5-5');
    expect(llm.maxTokens).toBe(8192);
  });

  it('accepts a custom model identifier and custom maxTokens', () => {
    const params: AnthropicLlmParams = {
      model: 'claude-opus-5-5',
      maxTokens: 4096,
    };
    const llm = new AnthropicLlm(params);
    expect(llm.model).toBe('claude-opus-5-5');
    expect(llm.maxTokens).toBe(4096);
  });

  it('distinguishes AnthropicLlm and Claude instances via isAnthropicLlm and isClaude', () => {
    const anthropicLlm = new AnthropicLlm();
    const claude = new Claude();

    expect(isAnthropicLlm(anthropicLlm)).toBe(true);
    expect(isClaude(anthropicLlm)).toBe(false);
    expect(isAnthropicLlm(claude)).toBe(true);
    expect(isClaude(claude)).toBe(true);
    expect(claude).toBeInstanceOf(AnthropicLlm);

    expect(isAnthropicLlm({})).toBe(false);
    expect(isAnthropicLlm(null)).toBe(false);
    expect(isAnthropicLlm('claude-sonnet-5-5')).toBe(false);

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
    expect(isAnthropicLlm(new OtherLlm())).toBe(false);
  });

  it('rejects connect() because live connections are not supported', async () => {
    const llm = new AnthropicLlm();
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    await expect(llm.connect(request)).rejects.toThrow(
      'Live connection is not supported for claude-sonnet-5-5.',
    );
  });

  it('generates a non-streaming response via the direct Anthropic client', async () => {
    const sampleMessage = createSampleAnthropicMessage({
      model: 'claude-sonnet-5-5',
      content: [
        {
          type: 'text',
          text: 'Hello, how can I help you?',
          citations: null,
        },
      ],
    });
    mockMessagesCreate.mockResolvedValue(sampleMessage);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const anthropicLlmInstance = new AnthropicLlm({
      model: 'claude-sonnet-5-5',
    });
    const abortController = new AbortController();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {systemInstruction: 'You are a helpful assistant'},
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    try {
      for await (const response of anthropicLlmInstance.generateContentAsync(
        request,
        false,
        abortController.signal,
      )) {
        responses.push(response);
      }

      expect(debugSpy).toHaveBeenCalledWith(
        'Claude response:',
        JSON.stringify(sampleMessage, null, 2),
      );
    } finally {
      debugSpy.mockRestore();
    }

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      content: {
        role: 'model',
        parts: [{text: 'Hello, how can I help you?'}],
      },
      finishReason: FinishReason.STOP,
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
      },
    });
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor).toHaveBeenCalledWith();
    expect(mockAnthropicVertexCtor).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      {
        model: 'claude-sonnet-5-5',
        system: 'You are a helpful assistant',
        messages: [{role: 'user', content: [{type: 'text', text: 'Hello'}]}],
        tools: undefined,
        tool_choice: undefined,
        max_tokens: 8192,
      },
      {signal: abortController.signal},
    );
  });

  it('collects function declarations across all config.tools entries', async () => {
    mockMessagesCreate.mockResolvedValue(
      createSampleAnthropicMessage({model: 'claude-sonnet-5-5'}),
    );

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Run both'}]}],
      config: {
        tools: [
          {
            functionDeclarations: [{name: 'first_tool'}],
          },
          {
            functionDeclarations: [{name: 'second_tool'}],
          },
        ],
      },
      liveConnectConfig: {},
      toolsDict: {
        first_tool: new FunctionTool({
          name: 'first_tool',
          description: 'First tool.',
          execute: () => 'ok',
        }),
        second_tool: new FunctionTool({
          name: 'second_tool',
          description: 'Second tool.',
          execute: () => 'ok',
        }),
      },
    };

    for await (const _ of llm.generateContentAsync(request, false)) {
      // consume response
    }

    const sentTools = mockMessagesCreate.mock.calls[0]?.[0]?.tools ?? [];
    expect(
      sentTools.map((tool) => ('name' in tool ? tool.name : undefined)),
    ).toEqual(['first_tool', 'second_tool']);
    expect(mockMessagesCreate.mock.calls[0]?.[0]?.tool_choice).toEqual({
      type: 'auto',
    });
  });

  it('sets tool_choice to auto when config.tools has declarations even if toolsDict is empty', async () => {
    mockMessagesCreate.mockResolvedValue(
      createSampleAnthropicMessage({model: 'claude-sonnet-5-5'}),
    );

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Call a tool'}]}],
      config: {
        tools: [
          {
            functionDeclarations: [{name: 'declared_only_tool'}],
          },
        ],
      },
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request, false)) {
      // consume response
    }

    expect(mockMessagesCreate.mock.calls[0]?.[0]?.tool_choice).toEqual({
      type: 'auto',
    });
  });

  it('supports a multi-tool_use parallel tool call and tool_result round-trip', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        createSampleAnthropicMessage({
          model: 'claude-sonnet-5-5',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_parallel_1',
              name: 'get_weather',
              input: {city: 'Paris'},
              caller: {type: 'direct'},
            },
            {
              type: 'tool_use',
              id: 'toolu_parallel_2',
              name: 'get_time',
              input: {city: 'Paris'},
              caller: {type: 'direct'},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        createSampleAnthropicMessage({
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: 'In Paris it is sunny and 14:00.',
              citations: null,
            },
          ],
        }),
      );

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const firstTurnRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Weather and time in Paris?'}]}],
      config: {
        tools: [
          {
            functionDeclarations: [{name: 'get_weather'}, {name: 'get_time'}],
          },
        ],
      },
      liveConnectConfig: {},
      toolsDict: {},
    };

    const firstTurnResponses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(firstTurnRequest)) {
      firstTurnResponses.push(response);
    }

    expect(firstTurnResponses).toHaveLength(1);
    expect(firstTurnResponses[0]?.content?.parts).toEqual([
      {
        functionCall: {
          id: 'toolu_parallel_1',
          name: 'get_weather',
          args: {city: 'Paris'},
        },
      },
      {
        functionCall: {
          id: 'toolu_parallel_2',
          name: 'get_time',
          args: {city: 'Paris'},
        },
      },
    ]);

    if (firstTurnResponses[0]?.content === undefined) {
      throw new Error('Expected first turn response to contain content.');
    }

    const secondTurnRequest: LlmRequest = {
      contents: [
        ...firstTurnRequest.contents,
        firstTurnResponses[0].content,
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'toolu_parallel_1',
                name: 'get_weather',
                response: {result: 'Sunny'},
              },
            },
            {
              functionResponse: {
                id: 'toolu_parallel_2',
                name: 'get_time',
                response: {result: '14:00'},
              },
            },
          ],
        },
      ],
      config: firstTurnRequest.config,
      liveConnectConfig: {},
      toolsDict: {},
    };

    const secondTurnResponses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(secondTurnRequest)) {
      secondTurnResponses.push(response);
    }

    expect(secondTurnResponses).toHaveLength(1);
    expect(secondTurnResponses[0]?.content?.parts).toEqual([
      {text: 'In Paris it is sunny and 14:00.'},
    ]);
    expect(mockMessagesCreate.mock.calls[1]?.[0]?.messages).toEqual([
      {
        role: 'user',
        content: [{type: 'text', text: 'Weather and time in Paris?'}],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_parallel_1',
            name: 'get_weather',
            input: {city: 'Paris'},
          },
          {
            type: 'tool_use',
            id: 'toolu_parallel_2',
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
            tool_use_id: 'toolu_parallel_1',
            content: 'Sunny',
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_parallel_2',
            content: '14:00',
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('forwards constructor maxTokens and allows llmRequest.config.maxOutputTokens to override it', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({maxTokens: 4096});
    const baseRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(baseRequest)) {
      // consume first response
    }

    expect(mockMessagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({max_tokens: 4096}),
      undefined,
    );

    for await (const _ of llm.generateContentAsync({
      ...baseRequest,
      config: {maxOutputTokens: 1024},
    })) {
      // consume second response
    }

    expect(mockMessagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({max_tokens: 1024}),
      undefined,
    );
  });

  it('caches the Anthropic client across calls on the same AnthropicLlm instance', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm();
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

    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it('retries client creation after a failed first call on the same AnthropicLlm instance', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const llm = new AnthropicLlm();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);

    vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-not-a-real-key');
    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(2);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('throws a credential error when the SDK resolves no credential', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    let thrownError: unknown;
    try {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    } catch (err: unknown) {
      thrownError = err;
    }

    if (!(thrownError instanceof Error)) {
      throw new Error('Expected generateContentAsync to reject with an Error.');
    }
    expect(thrownError.message).toContain('ANTHROPIC_API_KEY');
    expect(thrownError.message).toContain('export ANTHROPIC_API_KEY=');
    expect(thrownError.message).toContain('Claude');
    expect(thrownError.message).toContain('Vertex AI');

    const ctorFailure = new Error('SDK missing apiKey');
    mockAnthropicSdkState.ctorError = ctorFailure;
    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toMatchObject({
      message: expect.stringContaining('ANTHROPIC_API_KEY'),
      cause: ctorFailure,
    });
  });

  it('creates an Anthropic client from ANTHROPIC_API_KEY', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-not-a-real-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor.mock.instances[0]?.apiKey).toBe(
      'placeholder-not-a-real-key',
    );
  });

  it('creates an Anthropic client from ANTHROPIC_AUTH_TOKEN', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'placeholder-not-a-real-token');

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCtor.mock.instances[0]?.authToken).toBe(
      'placeholder-not-a-real-token',
    );
  });

  it('creates an Anthropic client from an SDK credential provider', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    const provider = {getAccessToken: vi.fn()};
    mockAnthropicSdkState.credentials = provider;

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    const createdClient = mockAnthropicCtor.mock.instances[0];
    expect(createdClient?.apiKey).toBeNull();
    expect(createdClient?.authToken).toBeNull();
    expect(createdClient?.credentials).toBe(provider);
  });

  it('accepts credentials resolved by the SDK without environment variables', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    const resolvedCredentials = {getAccessToken: vi.fn()};
    mockAnthropicSdkState.credentials = resolvedCredentials;

    const llm = new AnthropicLlm({model: 'claude-sonnet-5-5'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    const createdClient = mockAnthropicCtor.mock.instances[0];
    expect(createdClient?.apiKey).toBeNull();
    expect(createdClient?.authToken).toBeNull();
    expect(createdClient?.credentials).toBe(resolvedCredentials);
  });

  it('throws an installation error when @anthropic-ai/sdk is unavailable', async () => {
    mockAnthropicSdkState.shouldFailImport = true;

    const llm = new AnthropicLlm();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(async () => {
      for await (const _ of llm.generateContentAsync(request)) {
        // should fail before yielding
      }
    }).rejects.toThrow('Install it with: npm install @anthropic-ai/sdk');
  });

  it('succeeds when @anthropic-ai/vertex-sdk fails to import because AnthropicLlm only loads @anthropic-ai/sdk', async () => {
    mockImportState.shouldFailImport = true;
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm();
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
    expect(mockAnthropicVertexCtor).not.toHaveBeenCalled();
  });

  it('passes the thinking parameter in non-streaming requests', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({model: 'claude-sonnet-4-6'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Think carefully'}]}],
      config: {
        thinkingConfig: {
          thinkingBudget: 8000,
        },
      },
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: {
          type: 'enabled',
          budget_tokens: 8000,
        },
      }),
      undefined,
    );
  });

  it('omits the thinking parameter when thinkingConfig is unset', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({model: 'claude-sonnet-4-6'});
    const request: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hello'}]}],
      config: {},
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _ of llm.generateContentAsync(request)) {
      // consume generator
    }

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const callPayload = mockMessagesCreate.mock.calls[0]?.[0];
    expect(callPayload).toBeDefined();
    expect(callPayload !== undefined && 'thinking' in callPayload).toBe(false);
  });

  it('omits a turn containing only dropped parts instead of sending an empty message', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({model: 'claude-sonnet-4-6'});
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'Question'}]},
        {role: 'model', parts: [{thoughtSignature: 'foreign_sig'}]},
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Question'}],
          },
        ],
      }),
      undefined,
    );
  });

  it('retains a user turn with a lone empty text part using a placeholder block', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({model: 'claude-sonnet-4-6'});
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'run it'}]},
        {role: 'model', parts: [{text: 'running'}]},
        {role: 'user', parts: [{text: ''}]},
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'run it'}],
          },
          {
            role: 'assistant',
            content: [{type: 'text', text: 'running'}],
          },
          {
            role: 'user',
            content: [{type: 'text', text: '.'}],
          },
        ],
      }),
      undefined,
    );
  });

  it('converts thought parts with text and drops bare thought signatures in history', async () => {
    mockMessagesCreate.mockResolvedValue(createSampleAnthropicMessage());

    const llm = new AnthropicLlm({model: 'claude-sonnet-4-6'});
    const request: LlmRequest = {
      contents: [
        {role: 'user', parts: [{text: 'First question'}]},
        {
          role: 'model',
          parts: [
            {
              thought: true,
              text: 'Earlier reasoning',
              thoughtSignature: 'sig_1',
            },
            {thoughtSignature: 'sig_2'},
            {text: 'First answer', thoughtSignature: 'sig_3'},
          ],
        },
        {role: 'user', parts: [{text: 'Follow-up question'}]},
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'First question'}],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Earlier reasoning',
                signature: 'sig_1',
              },
              {type: 'text', text: 'First answer'},
            ],
          },
          {
            role: 'user',
            content: [{type: 'text', text: 'Follow-up question'}],
          },
        ],
      }),
      undefined,
    );
  });
});
