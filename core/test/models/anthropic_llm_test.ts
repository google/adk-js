/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmRequest} from '@google/adk';
import {AnthropicLlm, isBaseLlm, LlmAgent, LLMRegistry} from '@google/adk';
import type {Content} from '@google/genai';

// ---------------------------------------------------------------------------
// Helper: create a minimal LlmRequest
// ---------------------------------------------------------------------------
function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor & basics
// ---------------------------------------------------------------------------
describe('AnthropicLlm', () => {
  const originalEnv = process.env['ANTHROPIC_API_KEY'];

  afterEach(() => {
    if (originalEnv) {
      process.env['ANTHROPIC_API_KEY'] = originalEnv;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('should create instance with explicit API key', () => {
    const llm = new AnthropicLlm({
      model: 'claude-sonnet-4-5-20250929',
      apiKey: 'test-key',
    });
    expect(llm.model).toBe('claude-sonnet-4-5-20250929');
    expect(isBaseLlm(llm)).toBe(true);
  });

  it('should use default model name when not provided', () => {
    const llm = new AnthropicLlm({apiKey: 'test-key'});
    expect(llm.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should read API key from environment variable', () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-5-20250929'});
    expect(llm.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should throw when no API key is provided', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(
      () => new AnthropicLlm({model: 'claude-sonnet-4-5-20250929'}),
    ).toThrow(/API key/);
  });

  it('should throw on connect (live not supported)', async () => {
    const llm = new AnthropicLlm({apiKey: 'key'});
    await expect(llm.connect(makeLlmRequest())).rejects.toThrow(
      /not supported/,
    );
  });
});

// ---------------------------------------------------------------------------
// Model pattern matching
// ---------------------------------------------------------------------------
describe('AnthropicLlm.supportedModels', () => {
  it('should match claude model patterns', () => {
    const patterns = AnthropicLlm.supportedModels;
    const testCases = [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-0-20250514',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
    ];

    for (const modelName of testCases) {
      const matched = patterns.some((pattern) => {
        const regex =
          pattern instanceof RegExp
            ? new RegExp(`^${pattern.source}$`, pattern.flags)
            : new RegExp(`^${pattern}$`);
        return regex.test(modelName);
      });
      expect(matched).toBe(true);
    }
  });

  it('should not match non-claude patterns', () => {
    const patterns = AnthropicLlm.supportedModels;
    const nonClaude = ['gemini-2.5-flash', 'gpt-4o', 'llama-3'];

    for (const modelName of nonClaude) {
      const matched = patterns.some((pattern) => {
        const regex =
          pattern instanceof RegExp
            ? new RegExp(`^${pattern.source}$`, pattern.flags)
            : new RegExp(`^${pattern}$`);
        return regex.test(modelName);
      });
      expect(matched).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------
describe('LLMRegistry with AnthropicLlm', () => {
  it('should resolve claude model names via registry', () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const llm = LLMRegistry.newLlm('claude-sonnet-4-5-20250929');
    expect(llm).toBeInstanceOf(AnthropicLlm);
    expect(llm.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should work with LlmAgent using string model', () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const agent = new LlmAgent({
      name: 'test_claude_agent',
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(agent.canonicalModel).toBeInstanceOf(AnthropicLlm);
  });

  it('should work with LlmAgent using instance model', () => {
    const claude = new AnthropicLlm({
      model: 'claude-opus-4-0-20250514',
      apiKey: 'test-key',
    });
    const agent = new LlmAgent({name: 'test_agent', model: claude});
    expect(agent.canonicalModel).toBeInstanceOf(AnthropicLlm);
    expect(agent.canonicalModel.model).toBe('claude-opus-4-0-20250514');
  });
});

// ---------------------------------------------------------------------------
// Content → MessageParam conversion (via generateContentAsync mocking)
// ---------------------------------------------------------------------------
describe('AnthropicLlm content conversion', () => {
  let llm: AnthropicLlm;

  beforeEach(() => {
    llm = new AnthropicLlm({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  // Access private methods via casting for unit testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callConvertRequest(llmInst: any, llmRequest: LlmRequest) {
    return llmInst.convertRequest(llmRequest);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callConvertTools(llmInst: any, config: any) {
    return llmInst.convertTools(config);
  }

  it('should convert text contents correctly', () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'Hello'}]},
      {role: 'model', parts: [{text: 'Hi there'}]},
      {role: 'user', parts: [{text: 'How are you?'}]},
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('user');
  });

  it('should convert functionCall parts to tool_use blocks', () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'What is the weather?'}]},
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_123',
              name: 'get_weather',
              args: {location: 'Seoul'},
            },
          },
        ],
      },
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    expect(messages).toHaveLength(2);
    const assistantMsg = messages[1];
    expect(assistantMsg.role).toBe('assistant');

    const blocks = assistantMsg.content as Array<{
      type: string;
      id?: string;
      name?: string;
    }>;
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].id).toBe('call_123');
    expect(blocks[0].name).toBe('get_weather');
  });

  it('should convert functionResponse parts to tool_result blocks', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_123',
              name: 'get_weather',
              response: {result: 'Sunny, 25°C'},
            },
          },
        ],
      },
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    expect(messages).toHaveLength(1);
    const blocks = messages[0].content as Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
    }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('call_123');
    expect(blocks[0].content).toBe('Sunny, 25°C');
  });

  it('should merge consecutive same-role messages', () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'Hello'}]},
      {role: 'user', parts: [{text: 'World'}]},
      {role: 'model', parts: [{text: 'Response'}]},
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    // Two user messages should be merged into one
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    const blocks = messages[0].content as Array<{type: string; text: string}>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Hello');
    expect(blocks[1].text).toBe('World');
  });

  it('should prepend user message if first message is assistant', () => {
    const contents: Content[] = [
      {role: 'model', parts: [{text: 'I am the assistant'}]},
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('should extract system instruction from string', () => {
    const {system} = callConvertRequest(
      llm,
      makeLlmRequest({
        config: {systemInstruction: 'You are helpful'},
      }),
    );

    expect(system).toBe('You are helpful');
  });

  it('should extract system instruction from Content object', () => {
    const {system} = callConvertRequest(
      llm,
      makeLlmRequest({
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{text: 'Be concise'}, {text: 'Be accurate'}],
          },
        },
      }),
    );

    expect(system).toBe('Be concise\nBe accurate');
  });

  it('should skip thought parts', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {text: 'thinking...', thought: true} as Content['parts'][0],
          {text: 'Actual response'},
        ],
      },
    ];

    const {messages} = callConvertRequest(llm, makeLlmRequest({contents}));

    // The thought part should be skipped, only "Actual response" remains
    // But first message must be user, so a user message is prepended
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const assistantMsg = messages.find(
      (m: {role: string}) => m.role === 'assistant',
    );
    expect(assistantMsg).toBeDefined();
    const blocks = assistantMsg!.content as Array<{type: string; text: string}>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Actual response');
  });

  it('should convert function declarations to Anthropic tools', () => {
    const config = {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather for a location',
              parameters: {
                type: 'OBJECT',
                properties: {
                  location: {type: 'STRING', description: 'City name'},
                },
                required: ['location'],
              },
            },
          ],
        },
      ],
    };

    const tools = callConvertTools(llm, config);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_weather');
    expect(tools[0].description).toBe('Get weather for a location');
    expect(tools[0].input_schema.type).toBe('object');

    // Check that type strings are lowercased
    const props = tools[0].input_schema.properties as Record<
      string,
      {type: string}
    >;
    expect(props.location.type).toBe('string');
  });

  it('should handle nested schema type normalization', () => {
    const config = {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search',
              description: 'Search',
              parameters: {
                type: 'OBJECT',
                properties: {
                  tags: {
                    type: 'ARRAY',
                    items: {type: 'STRING'},
                  },
                },
              },
            },
          ],
        },
      ],
    };

    const tools = callConvertTools(llm, config);
    const props = tools[0].input_schema.properties as Record<
      string,
      {type: string; items?: {type: string}}
    >;
    expect(props.tags.type).toBe('array');
    expect(props.tags.items?.type).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------
describe('AnthropicLlm response conversion', () => {
  let llm: AnthropicLlm;

  beforeEach(() => {
    llm = new AnthropicLlm({apiKey: 'test-key'});
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function callConvertResponse(llmInst: any, message: any) {
    return llmInst.convertResponse(message);
  }

  it('should convert text response', () => {
    const message = {
      id: 'msg_123',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{type: 'text' as const, text: 'Hello!', citations: null}],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
      },
      container: null,
    };

    const response = callConvertResponse(llm, message);

    expect(response.content).toBeDefined();
    expect(response.content.role).toBe('model');
    expect(response.content.parts).toHaveLength(1);
    expect(response.content.parts[0].text).toBe('Hello!');
    expect(response.turnComplete).toBe(true);
  });

  it('should convert tool_use response', () => {
    const message = {
      id: 'msg_456',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'toolu_abc',
          name: 'get_weather',
          input: {location: 'Tokyo'},
          caller: {type: 'direct' as const},
        },
      ],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'tool_use' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        output_tokens: 15,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
      },
      container: null,
    };

    const response = callConvertResponse(llm, message);

    expect(response.content.parts).toHaveLength(1);
    const fc = response.content.parts[0].functionCall;
    expect(fc).toBeDefined();
    expect(fc.id).toBe('toolu_abc');
    expect(fc.name).toBe('get_weather');
    expect(fc.args).toEqual({location: 'Tokyo'});
  });

  it('should include usage metadata', () => {
    const message = {
      id: 'msg_789',
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{type: 'text' as const, text: 'Hi', citations: null}],
      model: 'claude-sonnet-4-5-20250929',
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
      },
      container: null,
    };

    const response = callConvertResponse(llm, message);

    expect(response.usageMetadata).toBeDefined();
    expect(response.usageMetadata.promptTokenCount).toBe(100);
    expect(response.usageMetadata.candidatesTokenCount).toBe(50);
    expect(response.usageMetadata.totalTokenCount).toBe(150);
  });
});
