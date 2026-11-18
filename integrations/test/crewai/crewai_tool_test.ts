/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool, GoogleLLMVariant} from '@google/adk';
import {CrewaiTool, isCrewaiTool} from '@google/adk-integrations';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

describe('CrewaiTool', () => {
  const emptyContext = {} as Context;

  it('identifies CrewaiTool instances via isCrewaiTool', () => {
    const crewaiTool = new CrewaiTool({
      tool: {
        name: 'Sample Tool',
        description: 'A sample CrewAI tool',
        run: () => 'ok',
      },
    });
    const fnTool = new FunctionTool({
      name: 'fn',
      description: 'fn',
      execute: () => 'ok',
    });

    expect(isCrewaiTool(crewaiTool)).toBe(true);
    expect(isCrewaiTool(fnTool)).toBe(false);
    expect(isCrewaiTool({})).toBe(false);
    expect(isCrewaiTool(null)).toBe(false);
    expect(isCrewaiTool(undefined)).toBe(false);
  });

  it('normalizes tool.name when custom name is omitted or empty', () => {
    const wrappedDefaultName = new CrewaiTool({
      tool: {
        name: 'Search the internet with Serper',
        description: 'Original description',
        run: () => 'result',
      },
    });
    expect(wrappedDefaultName.name).toBe('search_the_internet_with_serper');
    expect(wrappedDefaultName.description).toBe('Original description');

    const wrappedEmptyOverride = new CrewaiTool(
      {
        name: 'Custom Directory Reader',
        description: 'Original reader description',
        run: () => 'result',
      },
      {name: '', description: ''},
    );
    expect(wrappedEmptyOverride.name).toBe('custom_directory_reader');
    expect(wrappedEmptyOverride.description).toBe(
      'Original reader description',
    );
  });

  it('uses custom name and description overrides when provided', () => {
    const wrapped = new CrewaiTool({
      name: 'custom_serper_tool',
      description: 'Custom description override',
      tool: {
        name: 'Search the internet with Serper',
        description: 'Original description',
        run: () => 'result',
      },
    });

    expect(wrapped.name).toBe('custom_serper_tool');
    expect(wrapped.description).toBe('Custom description override');
  });

  it('builds a function declaration from a zod or JSON schema args schema', () => {
    const zodCrewTool = new CrewaiTool({
      name: 'serper_dev_tool',
      description: 'Search the internet with Serper',
      tool: {
        name: 'Search the internet with Serper',
        description: 'Original description',
        argsSchema: z.object({
          search_query: z
            .string()
            .describe('Mandatory search query you want to use'),
          country: z.string().optional().describe('Optional country code'),
        }),
        run: ({search_query}) => `Results for ${search_query}`,
      },
    });

    const zodDecl = zodCrewTool._getDeclaration();
    expect(zodDecl).toEqual({
      name: 'serper_dev_tool',
      description: 'Search the internet with Serper',
      parameters: {
        type: Type.OBJECT,
        properties: {
          search_query: {
            type: Type.STRING,
            description: 'Mandatory search query you want to use',
          },
          country: {
            type: Type.STRING,
            description: 'Optional country code',
          },
        },
        required: ['search_query'],
      },
    });

    const modelSchemaCrewTool = new CrewaiTool({
      tool: {
        name: 'Directory Read Tool',
        description: 'Use this to find files for you',
        argsSchema: {
          modelJsonSchema: () => ({
            properties: {
              mandatory_field: {type: 'string', title: 'Mandatory Field'},
              optional_field: {
                anyOf: [{type: 'integer'}, {type: 'null'}],
                default: null,
              },
            },
          }),
        },
        run: () => 'ok',
      },
    });

    expect(modelSchemaCrewTool._getDeclaration()).toEqual({
      name: 'directory_read_tool',
      description: 'Use this to find files for you',
      parameters: {
        type: Type.OBJECT,
        properties: {
          mandatory_field: {type: Type.STRING},
          optional_field: {type: Type.INTEGER},
        },
        required: ['mandatory_field'],
      },
    });
  });

  it('executes the wrapped CrewAI tool via runAsync', async () => {
    const runSpy = vi.fn(
      async (args: Record<string, unknown>) => `searched:${args['query']}`,
    );
    const tool = new CrewaiTool({
      tool: {
        name: 'Web Search',
        description: 'Searches the web',
        argsSchema: z.object({
          query: z.string(),
        }),
        run: runSpy,
      },
    });

    const response = await tool.runAsync({
      args: {query: 'search query'},
      toolContext: emptyContext,
    });

    expect(response).toBe('searched:search query');
    expect(runSpy).toHaveBeenCalledWith({query: 'search query'}, emptyContext);
  });

  it('builds no parameters for schemas without properties', () => {
    const schemas = [z.object({}), {type: 'object'}];
    for (const argsSchema of schemas) {
      const tool = new CrewaiTool({
        tool: {
          name: 'No Params Tool',
          description: 'Has no parameters',
          argsSchema,
          run: () => 'ok',
        },
      });

      expect(tool._getDeclaration()).toEqual({
        name: 'no_params_tool',
        description: 'Has no parameters',
      });
    }
  });

  it('does not mark fields as required when every schema field is optional', () => {
    const jsonSchema = {
      type: 'object',
      properties: {opt: {type: 'string'}},
    };
    const schemas = [
      z.object({opt: z.string().optional()}),
      jsonSchema,
      {jsonSchema: () => jsonSchema},
    ];
    for (const argsSchema of schemas) {
      const tool = new CrewaiTool({
        tool: {
          name: 'Optional Tool',
          description: 'All fields are optional',
          argsSchema,
          run: () => 'ok',
        },
      });

      expect(tool._getDeclaration()).toEqual({
        name: 'optional_tool',
        description: 'All fields are optional',
        parameters: {
          type: Type.OBJECT,
          properties: {opt: {type: Type.STRING}},
        },
      });
    }
    expect(jsonSchema).toEqual({
      type: 'object',
      properties: {opt: {type: 'string'}},
    });
  });

  describe('with the Vertex AI variant', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('builds the same normalized declaration as the Gemini API variant', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);
      const tool = new CrewaiTool({
        tool: {
          name: 'Vertex Tool',
          description: 'Runs under Vertex AI',
          argsSchema: z.object({
            search_query: z.string().describe('Search query'),
            country: z.string().optional(),
          }),
          run: () => 'ok',
        },
      });

      expect(tool.apiVariant).toBe(GoogleLLMVariant.VERTEX_AI);
      expect(tool._getDeclaration()).toEqual({
        name: 'vertex_tool',
        description: 'Runs under Vertex AI',
        parameters: {
          type: Type.OBJECT,
          properties: {
            search_query: {type: Type.STRING, description: 'Search query'},
            country: {type: Type.STRING},
          },
          required: ['search_query'],
        },
      });
    });
  });

  it('builds a function declaration from an argsSchema with toJsonSchema', () => {
    const tool = new CrewaiTool({
      tool: {
        name: 'Json Schema Tool',
        description: 'Uses toJsonSchema',
        argsSchema: {
          toJsonSchema: () => ({
            type: 'object',
            properties: {q: {type: 'string'}, n: {type: 'integer'}},
            required: ['q'],
          }),
        },
        run: () => 'ok',
      },
    });

    expect(tool._getDeclaration()).toEqual({
      name: 'json_schema_tool',
      description: 'Uses toJsonSchema',
      parameters: {
        type: Type.OBJECT,
        properties: {
          q: {type: Type.STRING},
          n: {type: Type.INTEGER},
        },
        required: ['q'],
      },
    });
  });
});
