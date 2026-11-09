/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool} from '@google/adk';
import {CrewaiTool, isCrewaiTool} from '@google/adk-integrations';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
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

  it('test_crewai_tool', () => {
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
});
