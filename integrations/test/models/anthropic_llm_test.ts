/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Message,
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type {LlmRequest, LlmResponse} from '@google/adk';
import {LlmAgent, LLMRegistry} from '@google/adk';
import type {AnthropicClient} from '@google/adk-integrations';
import {AnthropicLlm, Claude} from '@google/adk-integrations';
import type {Content, FunctionDeclaration} from '@google/genai';
import {FinishReason, Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const MODEL = 'claude-sonnet-4-5-20250929';
const VERTEX_MODEL_PATH =
  'projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1';

/** The last request the fake client was asked to send. */
let sentParams: MessageCreateParams | undefined;

/**
 * A client that answers with a canned message, and records what it was asked.
 */
function fakeClient(reply: Message | RawMessageStreamEvent[]): AnthropicClient {
  return {
    messages: {
      create: async (params: MessageCreateParams) => {
        sentParams = params;
        return Array.isArray(reply) ? asyncIterable(reply) : reply;
      },
    },
  } as unknown as AnthropicClient;
}

async function* asyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/** A minimal complete message, overridable per test. */
function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{type: 'text', text: 'hi', citations: null}],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  } as Message;
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/**
 * Runs a request through the model and returns everything it yielded, plus the
 * Anthropic request it produced along the way.
 */
async function run(
  llm: AnthropicLlm,
  llmRequest: LlmRequest,
  stream = false,
): Promise<{responses: LlmResponse[]; sent: MessageCreateParamsNonStreaming}> {
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(llmRequest, stream)) {
    responses.push(response);
  }
  return {
    responses,
    sent: sentParams as MessageCreateParamsNonStreaming,
  };
}

beforeEach(() => {
  sentParams = undefined;
});

describe('AnthropicLlm', () => {
  it('exposes the model it was constructed with', () => {
    const llm = new AnthropicLlm({model: MODEL, apiKey: 'k'});
    expect(llm.model).toBe(MODEL);
  });

  it('rejects a live connection, which Claude has no API for', async () => {
    const llm = new AnthropicLlm({model: MODEL, apiKey: 'k'});
    await expect(llm.connect(request())).rejects.toThrow(/not supported/);
  });

  it('resolves a bare claude model name through the registry', () => {
    expect(LLMRegistry.resolve(MODEL)).toBe(AnthropicLlm);
    expect(LLMRegistry.newLlm(MODEL)).toBeInstanceOf(AnthropicLlm);
  });

  it('resolves a Vertex resource name to the Vertex model', () => {
    expect(LLMRegistry.resolve(VERTEX_MODEL_PATH)).toBe(Claude);
  });

  it('leaves non-Claude model names to the other providers', () => {
    expect(LLMRegistry.resolve('gemini-2.5-flash')).not.toBe(AnthropicLlm);
    expect(() => LLMRegistry.resolve('gpt-4o')).toThrow(/not found/);
  });

  it('backs an LlmAgent named by a model string', () => {
    const agent = new LlmAgent({name: 'claude_agent', model: MODEL});
    expect(agent.canonicalModel).toBeInstanceOf(AnthropicLlm);
  });
});

describe('AnthropicLlm request conversion', () => {
  it('maps roles and carries text through', async () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'hello'}]},
      {role: 'model', parts: [{text: 'hi'}]},
      {role: 'user', parts: [{text: 'again'}]},
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    expect(sent.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(sent.messages[1].content).toEqual([{type: 'text', text: 'hi'}]);
  });

  it('converts a function call and its response into a paired round trip', async () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'weather?'}]},
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'toolu_1',
              name: 'get_weather',
              args: {city: 'Oslo'},
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'toolu_1',
              name: 'get_weather',
              response: {result: 'sunny'},
            },
          },
        ],
      },
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    expect(sent.messages[1].content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_weather',
        input: {city: 'Oslo'},
      },
    ]);
    expect(sent.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'sunny',
        is_error: false,
      },
    ]);
  });

  it('gives a call and its response the same ID when ADK stripped theirs', async () => {
    // The content processor removes an `adk-` prefixed ID before the request is
    // built, and Anthropic rejects a tool_use with no ID at all.
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'transfer'}]},
      {role: 'model', parts: [{functionCall: {name: 'transfer_to_agent'}}]},
      {
        role: 'user',
        parts: [{functionResponse: {name: 'transfer_to_agent', response: {}}}],
      },
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    const call = (sent.messages[1].content as Array<{id: string}>)[0];
    const result = (
      sent.messages[2].content as Array<{tool_use_id: string}>
    )[0];
    expect(call.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(result.tool_use_id).toBe(call.id);
  });

  it('drops a turn left with nothing Claude can receive', async () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'hello'}]},
      {role: 'model', parts: [{videoMetadata: {fps: 1}}]},
      {role: 'user', parts: [{text: 'still here'}]},
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    // The unusable turn is gone rather than sent with empty content, which
    // Anthropic rejects. The two user turns it separated then merge.
    expect(sent.messages).toEqual([
      {
        role: 'user',
        content: [
          {type: 'text', text: 'hello'},
          {type: 'text', text: 'still here'},
        ],
      },
    ]);
  });

  it('merges consecutive turns in the same role', async () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'first'}]},
      {role: 'user', parts: [{text: 'second'}]},
      {role: 'model', parts: [{text: 'answer'}]},
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    // ADK's own maybeAppendUserContent adds the trailing user turn, because the
    // history ends on the model.
    expect(sent.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(sent.messages[0].content).toEqual([
      {type: 'text', text: 'first'},
      {type: 'text', text: 'second'},
    ]);
  });

  it('opens on a user turn even when the history starts with the model', async () => {
    // A sub-agent sees this when the branch filter cuts the user turn that
    // started it, and Anthropic rejects a history opening on the assistant.
    const contents: Content[] = [
      {role: 'model', parts: [{text: 'I am mid-conversation'}]},
      {role: 'user', parts: [{text: 'carry on'}]},
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    expect(sent.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('round-trips a thinking block with its signature', async () => {
    const contents: Content[] = [
      {role: 'user', parts: [{text: 'think'}]},
      {
        role: 'model',
        parts: [
          {text: 'reasoning', thought: true, thoughtSignature: 'sig'},
          {text: 'answer'},
        ],
      },
      {role: 'user', parts: [{text: 'more'}]},
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    expect(sent.messages[1].content).toEqual([
      {type: 'thinking', thinking: 'reasoning', signature: 'sig'},
      {type: 'text', text: 'answer'},
    ]);
  });

  it('sends inline image data as an image block', async () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{inlineData: {mimeType: 'image/png', data: 'Ymluc'}}],
      },
    ];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request({contents}));

    expect(sent.messages[0].content).toEqual([
      {
        type: 'image',
        source: {type: 'base64', media_type: 'image/png', data: 'Ymluc'},
      },
    ]);
  });

  it('flattens a system instruction to the system parameter', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(
      llm,
      request({
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{text: 'Be concise'}, {text: 'Be accurate'}],
          },
        },
      }),
    );

    expect(sent.system).toBe('Be concise\nBe accurate');
  });

  it('honours maxOutputTokens over the constructor default', async () => {
    const llm = new AnthropicLlm({
      model: MODEL,
      maxTokens: 100,
      client: fakeClient(message()),
    });

    const withoutConfig = await run(llm, request());
    expect(withoutConfig.sent.max_tokens).toBe(100);

    const withConfig = await run(llm, request({config: {maxOutputTokens: 42}}));
    expect(withConfig.sent.max_tokens).toBe(42);
  });

  it('passes the sampling parameters through', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(
      llm,
      request({
        config: {
          temperature: 0.2,
          topP: 0.9,
          topK: 40.7,
          stopSequences: ['STOP'],
        },
      }),
    );

    expect(sent.temperature).toBe(0.2);
    expect(sent.top_p).toBe(0.9);
    expect(sent.top_k).toBe(40);
    expect(sent.stop_sequences).toEqual(['STOP']);
  });

  it('drops the sampling parameters while Claude is reasoning', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(
      llm,
      request({
        config: {temperature: 0.2, thinkingConfig: {thinkingBudget: 2048}},
      }),
    );

    expect(sent.thinking).toEqual({type: 'enabled', budget_tokens: 2048});
    expect(sent.temperature).toBeUndefined();
  });

  it('maps the thinking budget onto Claude thinking modes', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const disabled = await run(
      llm,
      request({config: {thinkingConfig: {thinkingBudget: 0}}}),
    );
    expect(disabled.sent.thinking).toEqual({type: 'disabled'});

    const adaptive = await run(
      llm,
      request({config: {thinkingConfig: {thinkingBudget: -1}}}),
    );
    expect(adaptive.sent.thinking).toEqual({type: 'adaptive'});
  });

  it('refuses a thinking config with no budget, which Claude cannot default', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    await expect(
      run(llm, request({config: {thinkingConfig: {}}})),
    ).rejects.toThrow(/thinkingBudget/);
  });
});

describe('AnthropicLlm tool conversion', () => {
  const declaration: FunctionDeclaration = {
    name: 'search',
    description: 'Search for things',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {type: Type.STRING, description: 'What to look for'},
        tags: {type: Type.ARRAY, items: {type: Type.STRING}, maxItems: '5'},
      },
      required: ['query'],
      propertyOrdering: ['query', 'tags'],
    },
  };

  it('rewrites a GenAI schema as the JSON Schema Anthropic validates', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(
      llm,
      request({config: {tools: [{functionDeclarations: [declaration]}]}}),
    );

    expect(sent.tools).toEqual([
      {
        name: 'search',
        description: 'Search for things',
        input_schema: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'What to look for'},
            // maxItems is an int64 string in GenAI but a number in JSON Schema.
            tags: {type: 'array', items: {type: 'string'}, maxItems: 5},
          },
          required: ['query'],
        },
      },
    ]);
    expect(sent.tool_choice).toEqual({type: 'auto'});
  });

  it('sends no tools when the request declares none', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(llm, request());

    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
  });

  it('passes a raw JSON Schema through, still rooted at an object', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {sent} = await run(
      llm,
      request({
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'echo',
                  parametersJsonSchema: {
                    type: 'object',
                    properties: {value: {type: 'string'}},
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    expect(sent.tools?.[0]).toMatchObject({
      name: 'echo',
      input_schema: {
        type: 'object',
        properties: {value: {type: 'string'}},
        additionalProperties: false,
      },
    });
  });
});

describe('AnthropicLlm response conversion', () => {
  it('converts text and reports the finish reason and usage', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(message())});

    const {responses} = await run(llm, request());

    expect(responses).toHaveLength(1);
    expect(responses[0].content).toEqual({
      role: 'model',
      parts: [{text: 'hi'}],
    });
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
    expect(responses[0].modelVersion).toBe(MODEL);
    expect(responses[0].usageMetadata).toMatchObject({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    });
  });

  it('converts a tool_use block to a function call', async () => {
    const llm = new AnthropicLlm({
      model: MODEL,
      client: fakeClient(
        message({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_9',
              name: 'get_weather',
              input: {city: 'Tokyo'},
            },
          ] as Message['content'],
        }),
      ),
    });

    const {responses} = await run(llm, request());

    expect(responses[0].content?.parts?.[0].functionCall).toEqual({
      id: 'toolu_9',
      name: 'get_weather',
      args: {city: 'Tokyo'},
    });
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
  });

  it('folds cached tokens into the prompt count and thinking out of the candidates', async () => {
    const llm = new AnthropicLlm({
      model: MODEL,
      client: fakeClient(
        message({
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_creation: null,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 20,
            inference_geo: null,
            output_tokens_details: {thinking_tokens: 30},
            server_tool_use: null,
            service_tier: null,
          },
        }),
      ),
    });

    const {responses} = await run(llm, request());

    expect(responses[0].usageMetadata).toEqual({
      promptTokenCount: 35,
      candidatesTokenCount: 70,
      totalTokenCount: 135,
      cachedContentTokenCount: 20,
      thoughtsTokenCount: 30,
    });
  });

  it('reports a truncated response as MAX_TOKENS', async () => {
    const llm = new AnthropicLlm({
      model: MODEL,
      client: fakeClient(message({stop_reason: 'max_tokens'})),
    });

    const {responses} = await run(llm, request());

    expect(responses[0].finishReason).toBe(FinishReason.MAX_TOKENS);
  });
});

describe('AnthropicLlm streaming', () => {
  const events: RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: message({content: [], usage: message().usage}),
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {type: 'text', text: '', citations: null},
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {type: 'text_delta', text: 'Hel'},
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {type: 'text_delta', text: 'lo'},
    },
    {type: 'content_block_stop', index: 0},
    {
      type: 'content_block_start',
      index: 1,
      content_block: {type: 'tool_use', id: 'toolu_2', name: 'ping', input: {}},
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {type: 'input_json_delta', partial_json: '{"host":'},
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {type: 'input_json_delta', partial_json: '"a.example"}'},
    },
    {type: 'content_block_stop', index: 1},
    {
      type: 'message_delta',
      delta: {stop_reason: 'tool_use', stop_sequence: null},
      usage: {output_tokens: 12},
    },
    {type: 'message_stop'},
  ] as RawMessageStreamEvent[];

  it('yields text deltas as partials, then one complete response', async () => {
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(events)});

    const {responses} = await run(llm, request(), true);

    const partials = responses.filter((r) => r.partial);
    expect(partials.map((r) => r.content?.parts?.[0].text)).toEqual([
      'Hel',
      'lo',
    ]);

    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(final.content?.parts).toEqual([
      {text: 'Hello'},
      // Tool arguments only parse once the whole JSON has arrived, so they are
      // assembled for the final response rather than streamed.
      {functionCall: {id: 'toolu_2', name: 'ping', args: {host: 'a.example'}}},
    ]);
    expect(final.finishReason).toBe(FinishReason.STOP);
    expect(final.usageMetadata?.candidatesTokenCount).toBe(12);
  });

  it('keeps a thinking signature that arrives after the thinking text', async () => {
    const thinkingEvents = [
      {type: 'message_start', message: message({content: []})},
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'thinking', thinking: '', signature: ''},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'weighing it up'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig-abc'},
      },
      {type: 'content_block_stop', index: 0},
      {type: 'message_stop'},
    ] as RawMessageStreamEvent[];
    const llm = new AnthropicLlm({
      model: MODEL,
      client: fakeClient(thinkingEvents),
    });

    const {responses} = await run(llm, request(), true);

    const final = responses[responses.length - 1];
    expect(final.content?.parts).toEqual([
      {text: 'weighing it up', thought: true, thoughtSignature: 'sig-abc'},
    ]);
  });

  it('survives tool arguments that never finished streaming', async () => {
    const truncated = [
      {type: 'message_start', message: message({content: []})},
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_3',
          name: 'ping',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'input_json_delta', partial_json: '{"host":'},
      },
      {type: 'message_stop'},
    ] as RawMessageStreamEvent[];
    const llm = new AnthropicLlm({model: MODEL, client: fakeClient(truncated)});

    const {responses} = await run(llm, request(), true);

    expect(responses[0].content?.parts?.[0].functionCall?.args).toEqual({});
  });
});

describe('Claude on Vertex AI', () => {
  it('strips the Vertex resource path down to the model ID', async () => {
    const llm = new Claude({
      model: VERTEX_MODEL_PATH,
      client: fakeClient(message()),
    });

    const {sent} = await run(llm, request());

    expect(sent.model).toBe('claude-opus-4-1');
  });

  it('reports what is missing when no project or region can be found', async () => {
    const project = process.env['GOOGLE_CLOUD_PROJECT'];
    const location = process.env['GOOGLE_CLOUD_LOCATION'];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];

    try {
      const llm = new Claude({model: 'claude-sonnet-4-5@20250929'});
      await expect(run(llm, request())).rejects.toThrow(
        /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION/,
      );
    } finally {
      if (project) process.env['GOOGLE_CLOUD_PROJECT'] = project;
      if (location) process.env['GOOGLE_CLOUD_LOCATION'] = location;
    }
  });

  it('takes the project and region from a fully qualified model name', async () => {
    const llm = new Claude({
      model: VERTEX_MODEL_PATH,
      client: fakeClient(message()),
    });

    // The client is provided, so nothing is resolved from the environment and
    // the request still goes out.
    const {responses} = await run(llm, request());

    expect(responses[0].content?.parts?.[0].text).toBe('hi');
  });
});
