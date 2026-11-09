/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {
  type Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LLMRegistry,
  RoutedLlm,
} from '@google/adk';
import {AnthropicLlm, Claude} from '@google/adk-integrations';
import {createUserContent, FinishReason} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  createRunner,
  GeminiWithMockResponses,
  type RawGenerateContentResponse,
} from '../../test_case_utils.js';

const {mockMessagesCreate, mockAnthropicCtor, mockAnthropicVertexCtor} =
  vi.hoisted(() => {
    const createFn =
      vi.fn<
        (
          body: Anthropic.MessageCreateParamsNonStreaming,
          options?: Anthropic.RequestOptions,
        ) => Promise<Anthropic.Message>
      >();
    const anthropicCtor = vi.fn(function (this: {
      apiKey?: string | null;
      authToken?: string | null;
      credentials?: unknown;
      messages: {create: typeof createFn};
    }) {
      this.apiKey = process.env['ANTHROPIC_API_KEY'] || null;
      this.authToken = process.env['ANTHROPIC_AUTH_TOKEN'] || null;
      this.credentials = null;
      this.messages = {create: createFn};
    });
    const vertexCtor = vi.fn(function (
      this: {
        options?: unknown;
        messages: {create: typeof createFn};
      },
      options: unknown,
    ) {
      this.options = options;
      this.messages = {create: createFn};
    });
    return {
      mockMessagesCreate: createFn,
      mockAnthropicCtor: anthropicCtor,
      mockAnthropicVertexCtor: vertexCtor,
    };
  });

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: mockAnthropicCtor,
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: mockAnthropicVertexCtor,
}));

function createAnthropicMessage(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
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

const getWeatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Retrieves the current weather report for a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: async ({city}: {city: string}) => {
    if (city.toLowerCase() === 'new york') {
      return {
        status: 'success',
        report:
          'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
      };
    }
    return {
      status: 'error',
      errorMessage: `Weather information for '${city}' is not available.`,
    };
  },
});

const getCurrentTimeTool = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z.string().describe('The name of the city.'),
  }),
  execute: async ({city}: {city: string}) => {
    if (city.toLowerCase() === 'new york') {
      return {
        status: 'success',
        report:
          'The current time in New York is 1/30/2026, 1:56:20 AM America/New_York',
      };
    }
    return {
      status: 'error',
      errorMessage: `Sorry, I don't have timezone information for ${city}.`,
    };
  },
});

describe('AnthropicLlm and Claude Integration', () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    mockAnthropicCtor.mockClear();
    mockAnthropicVertexCtor.mockClear();
    vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-not-a-real-key');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-gcp-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-east5');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('executes a multi-turn LlmAgent tool and thinking workflow with AnthropicLlm', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(
        createAnthropicMessage({
          id: 'msg_turn1_call',
          content: [
            {
              type: 'thinking',
              thinking: 'The user wants the weather in New York.',
              signature: 'sig_weather_1',
            },
            {
              type: 'text',
              text: '\n\n',
              citations: null,
            },
            {
              type: 'tool_use',
              id: 'toolu_weather_1',
              name: 'get_weather',
              input: {city: 'New York'},
              caller: {type: 'direct'},
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 162,
            output_tokens: 73,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: {thinking_tokens: 57},
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        createAnthropicMessage({
          id: 'msg_turn1_answer',
          content: [
            {
              type: 'text',
              text: 'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
              citations: null,
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 220,
            output_tokens: 22,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        createAnthropicMessage({
          id: 'msg_turn2_call',
          content: [
            {
              type: 'redacted_thinking',
              data: 'encrypted_thinking_turn2',
            },
            {
              type: 'tool_use',
              id: 'toolu_time_1',
              name: 'get_current_time',
              input: {city: 'New York'},
              caller: {type: 'direct'},
            },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 260,
            output_tokens: 65,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: {thinking_tokens: 47},
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        createAnthropicMessage({
          id: 'msg_turn2_answer',
          content: [
            {
              type: 'text',
              text: 'The current time in New York is 1/30/2026, 1:56:20 AM America/New_York',
              citations: null,
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 310,
            output_tokens: 33,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            cache_creation: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        }),
      );

    const agent = new LlmAgent({
      name: 'weather_time_agent',
      model: new AnthropicLlm({model: 'claude-sonnet-5-5'}),
      description:
        'Agent to answer questions about the time and weather in a city.',
      instruction:
        'You are a helpful agent who can answer user questions about the time and weather in a city.',
      generateContentConfig: {
        thinkingConfig: {
          thinkingBudget: 4096,
        },
      },
      tools: [getWeatherTool, getCurrentTimeTool],
    });

    const runner = await createRunner(agent);

    const turn1Events: Event[] = [];
    for await (const event of runner.run(
      'What is the weather like in New York?',
    )) {
      turn1Events.push(event);
    }

    expect(turn1Events).toHaveLength(3);
    expect(turn1Events[0]).toMatchObject({
      author: 'weather_time_agent',
      finishReason: FinishReason.STOP,
      content: {
        role: 'model',
        parts: [
          {
            text: 'The user wants the weather in New York.',
            thought: true,
            thoughtSignature: 'sig_weather_1',
          },
          {
            functionCall: {
              id: 'toolu_weather_1',
              name: 'get_weather',
              args: {city: 'New York'},
            },
          },
        ],
      },
      usageMetadata: {
        promptTokenCount: 162,
        candidatesTokenCount: 16,
        totalTokenCount: 235,
        thoughtsTokenCount: 57,
      },
    });
    expect(turn1Events[1]).toMatchObject({
      author: 'weather_time_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_weather_1',
              name: 'get_weather',
              response: {
                status: 'success',
                report:
                  'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
              },
            },
          },
        ],
      },
    });
    expect(turn1Events[2]).toMatchObject({
      author: 'weather_time_agent',
      finishReason: FinishReason.STOP,
      content: {
        role: 'model',
        parts: [
          {
            text: 'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
          },
        ],
      },
      usageMetadata: {
        promptTokenCount: 220,
        candidatesTokenCount: 22,
        totalTokenCount: 242,
      },
    });

    const turn2Events: Event[] = [];
    for await (const event of runner.run('What time is it in New York?')) {
      turn2Events.push(event);
    }

    expect(turn2Events).toHaveLength(3);
    expect(turn2Events[0]).toMatchObject({
      author: 'weather_time_agent',
      finishReason: FinishReason.STOP,
      content: {
        role: 'model',
        parts: [
          {
            thought: true,
            thoughtSignature: 'encrypted_thinking_turn2',
          },
          {
            functionCall: {
              id: 'toolu_time_1',
              name: 'get_current_time',
              args: {city: 'New York'},
            },
          },
        ],
      },
      usageMetadata: {
        promptTokenCount: 260,
        candidatesTokenCount: 18,
        totalTokenCount: 325,
        thoughtsTokenCount: 47,
      },
    });
    expect(turn2Events[2]).toMatchObject({
      author: 'weather_time_agent',
      finishReason: FinishReason.STOP,
      content: {
        role: 'model',
        parts: [
          {
            text: 'The current time in New York is 1/30/2026, 1:56:20 AM America/New_York',
          },
        ],
      },
    });

    expect(mockMessagesCreate).toHaveBeenCalledTimes(4);
    const fourthCall = mockMessagesCreate.mock.calls[3]?.[0];
    expect(fourthCall?.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });
    expect(fourthCall?.messages).toEqual([
      {
        role: 'user',
        content: [
          {type: 'text', text: 'What is the weather like in New York?'},
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'The user wants the weather in New York.',
            signature: 'sig_weather_1',
          },
          {
            type: 'tool_use',
            id: 'toolu_weather_1',
            name: 'get_weather',
            input: {city: 'New York'},
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_weather_1',
            content: JSON.stringify({
              status: 'success',
              report:
                'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
            }),
            is_error: false,
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
          },
        ],
      },
      {
        role: 'user',
        content: [{type: 'text', text: 'What time is it in New York?'}],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'redacted_thinking',
            data: 'encrypted_thinking_turn2',
          },
          {
            type: 'tool_use',
            id: 'toolu_time_1',
            name: 'get_current_time',
            input: {city: 'New York'},
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_time_1',
            content: JSON.stringify({
              status: 'success',
              report:
                'The current time in New York is 1/30/2026, 1:56:20 AM America/New_York',
            }),
            is_error: false,
          },
        ],
      },
    ]);
  });

  it('resolves Claude from LLMRegistry with adaptive thinking in InMemoryRunner', async () => {
    LLMRegistry.register(Claude);
    mockMessagesCreate.mockResolvedValueOnce(
      createAnthropicMessage({
        model: 'claude-opus-4-7@default',
        content: [
          {
            type: 'thinking',
            thinking: 'Adaptive reasoning.',
            signature: 'sig_adaptive',
          },
          {
            type: 'text',
            text: 'Resolved via Vertex AI Claude.',
            citations: null,
          },
        ],
      }),
    );

    const agent = new LlmAgent({
      name: 'vertex_claude_agent',
      model: 'claude-opus-4-7@default',
      instruction: 'Answer concisely.',
      generateContentConfig: {
        thinkingConfig: {
          thinkingBudget: -1,
        },
      },
    });

    const runner = await createRunner(agent);
    const events: Event[] = [];
    for await (const event of runner.run('Hello Claude')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.content?.parts).toEqual([
      {
        text: 'Adaptive reasoning.',
        thought: true,
        thoughtSignature: 'sig_adaptive',
      },
      {
        text: 'Resolved via Vertex AI Claude.',
      },
    ]);
    expect(mockAnthropicVertexCtor).toHaveBeenCalledWith({
      projectId: 'test-gcp-project',
      region: 'us-east5',
    });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-7@default',
        thinking: {
          type: 'adaptive',
          display: 'summarized',
        },
      }),
      undefined,
    );
  });

  it('continues a session on Claude after a Gemini turn with thought parts, bare thought signatures, and empty text', async () => {
    const geminiResponses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'Gemini thinking about New York weather.',
                  thought: true,
                  thoughtSignature: 'gemini_thought_sig',
                },
                {
                  functionCall: {
                    name: 'get_weather',
                    args: {city: 'New York'},
                  },
                  thoughtSignature: 'gemini_fc_sig',
                },
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {text: 'Sunny and 25C in New York.'},
                {text: '', thoughtSignature: 'gemini_trailing_sig'},
                {text: ''},
              ],
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];

    mockMessagesCreate.mockResolvedValueOnce(
      createAnthropicMessage({
        model: 'claude-sonnet-4-6@default',
        content: [
          {
            type: 'text',
            text: 'Claude follow-up based on the New York forecast.',
            citations: null,
          },
        ],
      }),
    );

    let activeModel = 'gemini';
    const routedLlm = new RoutedLlm({
      models: {
        gemini: new GeminiWithMockResponses(geminiResponses),
        claude: new Claude({model: 'claude-sonnet-4-6@default'}),
      },
      router: async () => activeModel,
    });

    const agent = new LlmAgent({
      name: 'handoff_agent',
      model: routedLlm,
      instruction: 'Help the user with travel weather.',
      tools: [getWeatherTool],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: agent.name,
    });
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'test_user',
    });

    const turn1Events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Check New York weather.'),
    })) {
      turn1Events.push(event);
    }
    expect(turn1Events).toHaveLength(3);

    activeModel = 'claude';
    const turn2Events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What should I pack?'),
    })) {
      turn2Events.push(event);
    }

    expect(turn2Events).toHaveLength(1);
    expect(turn2Events[0]?.content?.parts).toEqual([
      {text: 'Claude follow-up based on the New York forecast.'},
    ]);

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const claudeMessages = mockMessagesCreate.mock.calls[0]?.[0]?.messages;
    expect(claudeMessages).toEqual([
      {
        role: 'user',
        content: [{type: 'text', text: 'Check New York weather.'}],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Gemini thinking about New York weather.',
            signature: 'gemini_thought_sig',
          },
          {
            type: 'tool_use',
            id: 'toolu_fallback_0',
            name: 'get_weather',
            input: {city: 'New York'},
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_fallback_0',
            content: JSON.stringify({
              status: 'success',
              report:
                'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
            }),
            is_error: false,
          },
        ],
      },
      {
        role: 'assistant',
        content: [{type: 'text', text: 'Sunny and 25C in New York.'}],
      },
      {
        role: 'user',
        content: [{type: 'text', text: 'What should I pack?'}],
      },
    ]);
  });
});
