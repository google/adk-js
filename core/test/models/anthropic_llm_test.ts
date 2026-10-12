/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnthropicMessage,
  AnthropicMessageCreateParams,
  AnthropicVertexClient,
  BaseTool,
  Claude,
  ClaudeRequest,
  contentBlockToPart,
  contentToMessageParam,
  functionDeclarationToToolParam,
  FunctionTool,
  Gemini,
  isBaseLlm,
  isClaude,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  MAX_TOKEN,
  messageToGenerateContentResponse,
  partToMessageBlock,
  toClaudeRole,
  toGoogleGenaiFinishReason,
} from '@google/adk';
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  Part,
  Type,
} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const GEMINI_FAMILY_MODELS: readonly string[] = [
  'gemini-1.5-flash',
  'gemini-1.5-flash-001',
  'gemini-1.5-flash-002',
  'gemini-1.5-pro',
  'gemini-1.5-pro-001',
  'gemini-1.5-pro-002',
  'gemini-2.0-flash-exp',
  'projects/123456/locations/us-central1/endpoints/123456',
  'projects/123456/locations/us-central1/publishers/google/models/gemini-2.0-flash-exp',
];

const CLAUDE_FAMILY_MODELS: readonly string[] = [
  'claude-3-5-haiku@20241022',
  'claude-3-5-sonnet-v2@20241022',
  'claude-3-5-sonnet@20240620',
  'claude-3-haiku@20240307',
  'claude-3-opus@20240229',
  'claude-3-sonnet@20240229',
];

describe('LLMRegistry model resolution', () => {
  it.each(GEMINI_FAMILY_MODELS)(
    'test_match_gemini_family (%s)',
    (modelName) => {
      expect(LLMRegistry.resolve(modelName)).toBe(Gemini);
    },
  );

  it.each(CLAUDE_FAMILY_MODELS)(
    'test_match_claude_family (%s)',
    (modelName) => {
      LLMRegistry.register(Claude);

      expect(LLMRegistry.resolve(modelName)).toBe(Claude);
    },
  );

  it('test_non_exist_model', () => {
    expect(() => LLMRegistry.resolve('non-exist-model')).toThrow(
      'Model non-exist-model not found.',
    );
  });
});

describe('toClaudeRole', () => {
  it('maps model and assistant roles to assistant', () => {
    expect(toClaudeRole('model')).toBe('assistant');
    expect(toClaudeRole('assistant')).toBe('assistant');
  });

  it('maps user and unspecified roles to user', () => {
    expect(toClaudeRole('user')).toBe('user');
    expect(toClaudeRole(undefined)).toBe('user');
    expect(toClaudeRole(null)).toBe('user');
    expect(toClaudeRole('system')).toBe('user');
  });
});

describe('toGoogleGenaiFinishReason', () => {
  it.each(['end_turn', 'stop_sequence', 'tool_use'])(
    'maps %s to FinishReason.STOP',
    (reason) => {
      expect(toGoogleGenaiFinishReason(reason)).toBe(FinishReason.STOP);
    },
  );

  it('maps max_tokens to FinishReason.MAX_TOKENS', () => {
    expect(toGoogleGenaiFinishReason('max_tokens')).toBe(
      FinishReason.MAX_TOKENS,
    );
  });

  it('maps unknown or missing reasons to FinishReason.FINISH_REASON_UNSPECIFIED', () => {
    expect(toGoogleGenaiFinishReason(undefined)).toBe(
      FinishReason.FINISH_REASON_UNSPECIFIED,
    );
    expect(toGoogleGenaiFinishReason(null)).toBe(
      FinishReason.FINISH_REASON_UNSPECIFIED,
    );
    expect(toGoogleGenaiFinishReason('unknown')).toBe(
      FinishReason.FINISH_REASON_UNSPECIFIED,
    );
  });
});

describe('partToMessageBlock', () => {
  it('converts a text part into a text block parameter', () => {
    const part: Part = {text: 'Hello Claude'};
    expect(partToMessageBlock(part)).toEqual({
      type: 'text',
      text: 'Hello Claude',
    });
  });

  it('converts a functionCall part into a tool_use block parameter', () => {
    const part: Part = {
      functionCall: {
        id: 'call_123',
        name: 'get_weather',
        args: {city: 'Paris'},
      },
    };
    expect(partToMessageBlock(part)).toEqual({
      type: 'tool_use',
      id: 'call_123',
      name: 'get_weather',
      input: {city: 'Paris'},
    });
  });

  it('defaults functionCall id to an empty string when omitted', () => {
    const part: Part = {
      functionCall: {
        name: 'get_weather',
        args: {city: 'London'},
      },
    };
    expect(partToMessageBlock(part)).toEqual({
      type: 'tool_use',
      id: '',
      name: 'get_weather',
      input: {city: 'London'},
    });
  });

  it('throws when a functionCall part is missing a name', () => {
    const part: Part = {
      functionCall: {
        id: 'call_no_name',
        args: {},
      },
    };
    expect(() => partToMessageBlock(part)).toThrow(
      'Function call must have a name.',
    );
  });

  it('converts a functionResponse part with a string result into a tool_result block', () => {
    const part: Part = {
      functionResponse: {
        id: 'call_123',
        name: 'get_weather',
        response: {result: 'Sunny, 22C'},
      },
    };
    expect(partToMessageBlock(part)).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_123',
      content: 'Sunny, 22C',
      is_error: false,
    });
  });

  it('stringifies non-string result values in a functionResponse part', () => {
    const objectResultPart: Part = {
      functionResponse: {
        id: 'call_456',
        name: 'list_items',
        response: {result: [{id: 1, name: 'item'}]},
      },
    };
    expect(partToMessageBlock(objectResultPart)).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_456',
      content: '[{"id":1,"name":"item"}]',
      is_error: false,
    });

    const numberResultPart: Part = {
      functionResponse: {
        name: 'count_items',
        response: {result: 42},
      },
    };
    expect(partToMessageBlock(numberResultPart)).toEqual({
      type: 'tool_result',
      tool_use_id: '',
      content: '42',
      is_error: false,
    });
  });

  it('uses an empty string content when functionResponse has no truthy result', () => {
    const emptyResponsePart: Part = {
      functionResponse: {
        id: 'call_789',
        name: 'noop',
        response: {},
      },
    };
    expect(partToMessageBlock(emptyResponsePart)).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_789',
      content: '',
      is_error: false,
    });
  });

  it('throws on an unsupported part', () => {
    const unsupportedPart: Part = {
      inlineData: {mimeType: 'image/png', data: 'aGVsbG8='},
    };
    expect(() => partToMessageBlock(unsupportedPart)).toThrow(
      'Not supported yet.',
    );
  });
});

describe('contentToMessageParam', () => {
  it('converts a Content object with multiple parts into an AnthropicMessageParam', () => {
    const content: Content = {
      role: 'model',
      parts: [
        {text: 'Checking weather'},
        {
          functionCall: {
            id: 'call_1',
            name: 'get_weather',
            args: {city: 'Tokyo'},
          },
        },
      ],
    };
    expect(contentToMessageParam(content)).toEqual({
      role: 'assistant',
      content: [
        {type: 'text', text: 'Checking weather'},
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_weather',
          input: {city: 'Tokyo'},
        },
      ],
    });
  });

  it('handles a Content object with undefined parts', () => {
    const content: Content = {role: 'user'};
    expect(contentToMessageParam(content)).toEqual({
      role: 'user',
      content: [],
    });
  });
});

describe('contentBlockToPart', () => {
  it('converts a text content block into a text Part', () => {
    expect(
      contentBlockToPart({
        type: 'text',
        text: 'Hello from Claude',
      }),
    ).toEqual({
      text: 'Hello from Claude',
    });
  });

  it('converts a tool_use content block into a functionCall Part with id', () => {
    expect(
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_01',
        name: 'get_weather',
        input: {city: 'Berlin'},
      }),
    ).toEqual({
      functionCall: {
        id: 'toolu_01',
        name: 'get_weather',
        args: {city: 'Berlin'},
      },
    });
  });

  it('throws when a tool_use content block input is not an object', () => {
    expect(() =>
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_02',
        name: 'get_weather',
        input: 'invalid-input',
      }),
    ).toThrow('Tool use block input must be an object.');
  });

  it('throws on an unsupported content block type', () => {
    expect(() =>
      contentBlockToPart({
        type: 'thinking',
        thinking: 'internal reasoning',
      }),
    ).toThrow('Not supported yet.');
  });
});

describe('messageToGenerateContentResponse', () => {
  it('converts an AnthropicMessage into an LlmResponse with model role', () => {
    const message: AnthropicMessage = {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-v2@20241022',
      content: [
        {type: 'text', text: 'Let me check that for you.'},
        {
          type: 'tool_use',
          id: 'toolu_99',
          name: 'lookup_order',
          input: {orderId: 'ORD-100'},
        },
      ],
      stop_reason: 'tool_use',
      usage: {input_tokens: 25, output_tokens: 15},
    };

    expect(messageToGenerateContentResponse(message)).toEqual({
      content: {
        role: 'model',
        parts: [
          {text: 'Let me check that for you.'},
          {
            functionCall: {
              id: 'toolu_99',
              name: 'lookup_order',
              args: {orderId: 'ORD-100'},
            },
          },
        ],
      },
    });
  });
});

describe('functionDeclarationToToolParam', () => {
  it('converts a FunctionDeclaration with parameters into an AnthropicToolParam', () => {
    const declaration: FunctionDeclaration = {
      name: 'get_weather',
      description: 'Gets the current weather for a city.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {
            type: Type.STRING,
            description: 'The city name.',
          },
          days: {
            type: Type.INTEGER,
            description: 'Number of forecast days.',
          },
        },
      },
    };

    expect(functionDeclarationToToolParam(declaration)).toEqual({
      name: 'get_weather',
      description: 'Gets the current weather for a city.',
      input_schema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'The city name.',
          },
          days: {
            type: 'integer',
            description: 'Number of forecast days.',
          },
        },
      },
    });
  });

  it('defaults description to empty string and properties to empty object when omitted', () => {
    const declaration: FunctionDeclaration = {
      name: 'ping',
    };

    expect(functionDeclarationToToolParam(declaration)).toEqual({
      name: 'ping',
      description: '',
      input_schema: {
        type: 'object',
        properties: {},
      },
    });
  });

  it('throws when FunctionDeclaration name is missing', () => {
    const declaration: FunctionDeclaration = {
      description: 'Unnamed tool',
    };
    expect(() => functionDeclarationToToolParam(declaration)).toThrow(
      'Function declaration must have a name.',
    );
  });
});

describe('Claude and isClaude', () => {
  const clearEnv = () => {
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  };

  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('identifies Claude instances with isClaude and isBaseLlm', () => {
    const claude = new Claude();
    expect(isClaude(claude)).toBe(true);
    expect(isBaseLlm(claude)).toBe(true);
    expect(isClaude(null)).toBe(false);
    expect(isClaude({})).toBe(false);
    expect(isClaude('claude')).toBe(false);
  });

  it('uses claude-3-5-sonnet-v2@20241022 as the default model and MAX_TOKEN = 1024', () => {
    const claude = new Claude();
    expect(claude.model).toBe('claude-3-5-sonnet-v2@20241022');
    expect(MAX_TOKEN).toBe(1024);

    const requestShape: ClaudeRequest = {
      systemInstruction: 'Be concise.',
      messages: [],
      tools: [],
    };
    expect(requestShape.systemInstruction).toBe('Be concise.');
  });

  it('sends messages, system instruction, tools, and tool_choice when toolsDict is populated', async () => {
    const createdParams: AnthropicMessageCreateParams[] = [];
    const mockClient: AnthropicVertexClient = {
      messages: {
        async create(
          params: AnthropicMessageCreateParams,
        ): Promise<AnthropicMessage> {
          createdParams.push(params);
          return {
            content: [{type: 'text', text: 'It is sunny in Paris.'}],
          };
        },
      },
    };

    const weatherTool: BaseTool = new FunctionTool({
      name: 'get_weather',
      description: 'Gets weather.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {type: Type.STRING, description: 'City name'},
        },
      },
      execute: async () => ({result: 'sunny'}),
    });

    const claude = new Claude({
      model: 'claude-3-5-haiku@20241022',
      client: mockClient,
    });

    const llmRequest: LlmRequest = {
      model: 'claude-3-5-haiku@20241022',
      contents: [{role: 'user', parts: [{text: 'Weather in Paris?'}]}],
      config: {
        systemInstruction: 'You are a weather assistant.',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Gets weather.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    city: {type: Type.STRING, description: 'City name'},
                  },
                },
              },
            ],
          },
        ],
      },
      liveConnectConfig: {},
      toolsDict: {get_weather: weatherTool},
    };

    const responses: LlmResponse[] = [];
    for await (const response of claude.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses).toEqual([
      {
        content: {
          role: 'model',
          parts: [{text: 'It is sunny in Paris.'}],
        },
      },
    ]);

    expect(createdParams).toEqual([
      {
        model: 'claude-3-5-haiku@20241022',
        system: 'You are a weather assistant.',
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Weather in Paris?'}],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Gets weather.',
            input_schema: {
              type: 'object',
              properties: {
                city: {type: 'string', description: 'City name'},
              },
            },
          },
        ],
        tool_choice: {
          type: 'auto',
          disable_parallel_tool_use: true,
        },
        max_tokens: MAX_TOKEN,
      },
    ]);
  });

  it('omits tools and tool_choice when request has no tools and an empty toolsDict', async () => {
    const createdParams: AnthropicMessageCreateParams[] = [];
    const mockClient: AnthropicVertexClient = {
      messages: {
        async create(
          params: AnthropicMessageCreateParams,
        ): Promise<AnthropicMessage> {
          createdParams.push(params);
          return {
            content: [{type: 'text', text: 'Hello!'}],
          };
        },
      },
    };

    const claude = new Claude({client: mockClient});
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      config: {},
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses: LlmResponse[] = [];
    for await (const response of claude.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(createdParams).toEqual([
      {
        model: 'claude-3-5-sonnet-v2@20241022',
        system: undefined,
        messages: [
          {
            role: 'user',
            content: [{type: 'text', text: 'Hi'}],
          },
        ],
        tools: undefined,
        tool_choice: undefined,
        max_tokens: 1024,
      },
    ]);
  });

  it('throws when GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION is missing', async () => {
    const claude = new Claude();
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const collect = async () => {
      const out: LlmResponse[] = [];
      for await (const r of claude.generateContentAsync(llmRequest)) {
        out.push(r);
      }
      return out;
    };

    await expect(collect()).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );

    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    await expect(collect()).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );
  });

  it('throws an informative error when @anthropic-ai/vertex-sdk is not installed', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-east5';

    const claude = new Claude();
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Hi'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const collect = async () => {
      const out: LlmResponse[] = [];
      for await (const r of claude.generateContentAsync(llmRequest)) {
        out.push(r);
      }
      return out;
    };

    await expect(collect()).rejects.toThrow(
      "Claude needs the optional package '@anthropic-ai/vertex-sdk', which is not installed.",
    );
  });

  it('rejects connect calls because live connections are not supported', async () => {
    const claude = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await expect(claude.connect(llmRequest)).rejects.toThrow(
      'Live connection is not supported for claude-3-5-sonnet-v2@20241022.',
    );
  });
});
