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
import {Type} from '@google/genai';
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
    const createFn = vi.fn();
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

  it('uses claude-sonnet-4-6@default when no model is specified', () => {
    const llm = new Claude();
    expect(llm.model).toBe('claude-sonnet-4-6@default');
    expect(MAX_TOKEN).toBe(1024);
  });

  it('accepts a custom model identifier', () => {
    const llm = new Claude({model: 'claude-opus-4-7@default'});
    expect(llm.model).toBe('claude-opus-4-7@default');
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
        max_tokens: 1024,
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
        max_tokens: 1024,
      },
      undefined,
    );
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
