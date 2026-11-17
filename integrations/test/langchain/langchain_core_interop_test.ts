/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  type Context,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {
  type LangchainPublicToolLike,
  LangchainTool,
  type LegacyLangchainToolLike,
} from '@google/adk-integrations';
import {Type} from '@google/genai';
import {
  DynamicStructuredTool,
  DynamicTool,
  StructuredTool,
  tool,
} from '@langchain/core/tools';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

class ScriptedToolLlm extends BaseLlm {
  private turn = 0;

  constructor(
    private readonly toolName: string,
    private readonly toolArgs: Record<string, unknown>,
  ) {
    super({model: 'scripted-model'});
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.turn++;
    if (this.turn === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: this.toolName,
                args: this.toolArgs,
              },
            },
          ],
        },
      };
      return;
    }

    const fnResponse = llmRequest.contents
      .flatMap((content) => content.parts ?? [])
      .find((part) => part.functionResponse);
    yield {
      content: {
        role: 'model',
        parts: [
          {
            text: `tool_result:${JSON.stringify(
              fnResponse?.functionResponse?.response,
            )}`,
          },
        ],
      },
    };
  }

  override async connect(): Promise<never> {
    throw new Error('connect is not implemented in ScriptedToolLlm');
  }
}

describe('LangchainTool interop with @langchain/core/tools', () => {
  const emptyContext = {} as Context;

  beforeEach(() => {
    vi.stubEnv('LANGSMITH_TRACING', 'false');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('re-exports LangchainPublicToolLike and LegacyLangchainToolLike', () => {
    const publicTool: LangchainPublicToolLike = {
      name: 'public_tool',
      description: 'Uses invoke',
      invoke: () => 'ok',
    };
    const legacyTool: LegacyLangchainToolLike = {
      name: 'legacy_tool',
      description: 'Uses _run',
      _run: () => 'ok',
    };

    expect(new LangchainTool(publicTool).name).toBe('public_tool');
    expect(new LangchainTool(legacyTool).name).toBe('legacy_tool');
  });

  it('wraps @langchain/core tool() with Zod v4 schema and preserves optionality', async () => {
    const lcTool = tool(
      async ({query, limit, mode, note}) =>
        `${query}|${limit ?? 'none'}|${mode}|${note ?? 'null'}`,
      {
        name: 'search_docs',
        description: 'Searches documentation',
        schema: z4.object({
          query: z4.string().describe('Search query'),
          limit: z4.number().int().optional().describe('Max results'),
          mode: z4.enum(['fast', 'full']).default('fast'),
          note: z4.string().nullable(),
        }),
      },
    );

    const wrapped = new LangchainTool(lcTool);
    expect(wrapped.name).toBe('search_docs');
    expect(wrapped.description).toBe('Searches documentation');
    expect(wrapped._getDeclaration()).toEqual({
      name: 'search_docs',
      description: 'Searches documentation',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {type: Type.STRING, description: 'Search query'},
          limit: {
            type: Type.INTEGER,
            description: 'Max results',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          mode: {type: Type.STRING, enum: ['fast', 'full']},
          note: {type: Type.STRING},
        },
        required: ['query'],
      },
    });

    const result = await wrapped.runAsync({
      args: {query: 'adk', note: null},
      toolContext: emptyContext,
    });
    expect(result).toBe('adk|none|fast|null');
  });

  it('wraps @langchain/core DynamicStructuredTool with Zod v3 and JSON Schema', async () => {
    const z3Tool = new DynamicStructuredTool({
      name: 'z3_calc',
      description: 'Adds numbers',
      schema: z3.object({
        a: z3.number(),
        b: z3.number().optional(),
      }),
      func: async ({a, b}) => String(a + (b ?? 0)),
    });

    const wrappedZ3 = new LangchainTool(z3Tool);
    expect(wrappedZ3._getDeclaration()).toEqual({
      name: 'z3_calc',
      description: 'Adds numbers',
      parameters: {
        type: Type.OBJECT,
        properties: {
          a: {type: Type.NUMBER},
          b: {type: Type.NUMBER},
        },
        required: ['a'],
      },
    });
    expect(
      await wrappedZ3.runAsync({args: {a: 7}, toolContext: emptyContext}),
    ).toBe('7');

    const jsonSchemaTool = new DynamicStructuredTool({
      name: 'json_calc',
      description: 'Uses JSON schema',
      schema: {
        type: 'object',
        properties: {
          requiredField: {type: 'string'},
          optionalField: {type: 'integer'},
        },
        required: ['requiredField'],
      },
      func: async ({requiredField, optionalField}) =>
        `${requiredField}:${optionalField ?? 0}`,
    });

    const wrappedJson = new LangchainTool(jsonSchemaTool);
    expect(wrappedJson._getDeclaration()).toEqual({
      name: 'json_calc',
      description: 'Uses JSON schema',
      parameters: {
        type: Type.OBJECT,
        properties: {
          requiredField: {type: Type.STRING},
          optionalField: {type: Type.INTEGER},
        },
        required: ['requiredField'],
      },
    });
    expect(
      await wrappedJson.runAsync({
        args: {requiredField: 'ok'},
        toolContext: emptyContext,
      }),
    ).toBe('ok:0');
  });

  it('wraps @langchain/core DynamicTool and string-schema tool()', async () => {
    const dynamicTool = new DynamicTool({
      name: 'echo_dynamic',
      description: 'Echoes string input',
      func: async (input) => `echo:${input}`,
    });
    const stringTool = tool(async (input) => `str:${input}`, {
      name: 'echo_string_tool',
      description: 'Echoes via tool() string schema',
      schema: z4.string(),
    });

    const wrappedDynamic = new LangchainTool(dynamicTool);
    expect(wrappedDynamic._getDeclaration()).toEqual({
      name: 'echo_dynamic',
      description: 'Echoes string input',
      parameters: {
        type: Type.OBJECT,
        properties: {
          input: {type: Type.STRING},
        },
      },
    });
    expect(
      await wrappedDynamic.runAsync({
        args: {input: 'hello'},
        toolContext: emptyContext,
      }),
    ).toBe('echo:hello');

    const wrappedString = new LangchainTool(stringTool);
    expect(wrappedString._getDeclaration()).toEqual({
      name: 'echo_string_tool',
      description: 'Echoes via tool() string schema',
      parameters: {
        type: Type.OBJECT,
        properties: {
          input: {type: Type.STRING},
        },
      },
    });
    expect(
      await wrappedString.runAsync({
        args: {input: 'world'},
        toolContext: emptyContext,
      }),
    ).toBe('str:world');
  });

  it('wraps a @langchain/core StructuredTool subclass', async () => {
    const schema = z4.object({
      city: z4.string(),
      units: z4.enum(['c', 'f']).optional(),
    });

    class WeatherTool extends StructuredTool<typeof schema> {
      name = 'get_weather';
      description = 'Gets weather for a city';
      schema = schema;

      protected override async _call(arg: {
        city: string;
        units?: 'c' | 'f';
      }): Promise<string> {
        return `${arg.city}:${arg.units ?? 'c'}`;
      }
    }

    const wrapped = new LangchainTool(new WeatherTool());
    expect(wrapped._getDeclaration()).toEqual({
      name: 'get_weather',
      description: 'Gets weather for a city',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {type: Type.STRING},
          units: {type: Type.STRING, enum: ['c', 'f']},
        },
        required: ['city'],
      },
    });
    expect(
      await wrapped.runAsync({
        args: {city: 'Tokyo'},
        toolContext: emptyContext,
      }),
    ).toBe('Tokyo:c');
  });

  it('runs a real @langchain/core tool() end-to-end inside LlmAgent and InMemoryRunner with a real Context', async () => {
    const multiplyTool = tool(
      async ({x, y}) => ({
        product: x * y,
      }),
      {
        name: 'multiply_numbers',
        description: 'Multiplies two numbers',
        schema: z4.object({
          x: z4.number(),
          y: z4.number(),
        }),
      },
    );

    const agent = new LlmAgent({
      name: 'math_agent',
      model: new ScriptedToolLlm('multiply_numbers', {x: 6, y: 7}),
      tools: [new LangchainTool(multiplyTool)],
    });
    const runner = new InMemoryRunner({agent, appName: 'langchain_interop'});
    const session = await runner.sessionService.createSession({
      appName: 'langchain_interop',
      userId: 'user-1',
    });

    let finalText = '';
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Multiply 6 by 7'}]},
    })) {
      if (isFinalResponse(event)) {
        finalText =
          event.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
      }
    }

    expect(finalText).toBe('tool_result:{"product":42}');
  });
});
