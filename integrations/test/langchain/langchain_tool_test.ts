/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool, GoogleLLMVariant} from '@google/adk';
import {
  isLangchainTool,
  LangchainTool,
  type LangchainToolLike,
} from '@google/adk-integrations';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

describe('LangchainTool', () => {
  const emptyContext = {} as Context;

  it('identifies LangchainTool instances via isLangchainTool', () => {
    const lcTool = new LangchainTool({
      name: 'lc_search',
      description: 'LangChain search tool',
      _run: () => 'ok',
    });
    const fnTool = new FunctionTool({
      name: 'fn',
      description: 'fn',
      execute: () => 'ok',
    });

    expect(isLangchainTool(lcTool)).toBe(true);
    expect(isLangchainTool(fnTool)).toBe(false);
    expect(isLangchainTool({})).toBe(false);
    expect(isLangchainTool(null)).toBe(false);
    expect(isLangchainTool(undefined)).toBe(false);
  });

  it('builds FunctionDeclaration for structured BaseTool-like tools with argsSchema, schema, or args', () => {
    const structuredWithZod = new LangchainTool({
      tool: {
        name: 'calculator',
        description: 'Evaluates math expressions',
        schema: z.object({
          expression: z.string().describe('Expression to evaluate'),
          precision: z.number().optional().describe('Decimal precision'),
        }),
        _call: ({expression}) => `result:${expression}`,
      },
    });

    expect(structuredWithZod._getDeclaration()).toEqual({
      name: 'calculator',
      description: 'Evaluates math expressions',
      parameters: {
        type: Type.OBJECT,
        properties: {
          expression: {
            type: Type.STRING,
            description: 'Expression to evaluate',
          },
          precision: {
            type: Type.NUMBER,
            description: 'Decimal precision',
          },
        },
        required: ['expression'],
      },
    });

    const structuredWithRawArgs = new LangchainTool(
      {
        name: 'original_name',
        description: 'Original description',
        args: {
          topic: {type: 'string', title: 'Topic'},
          max_items: {
            anyOf: [{type: 'integer'}, {type: 'null'}],
            default: null,
          },
        },
        _run: ({topic}) => `summary:${topic}`,
      },
      {
        name: 'custom_summarizer',
        description: 'Custom summarizer description',
      },
    );

    expect(structuredWithRawArgs._getDeclaration()).toEqual({
      name: 'custom_summarizer',
      description: 'Custom summarizer description',
      parameters: {
        type: Type.OBJECT,
        properties: {
          topic: {type: Type.STRING},
          max_items: {type: Type.INTEGER},
        },
        required: ['topic'],
      },
    });
  });

  it('builds FunctionDeclaration via buildFunctionDeclarationUtil for simple run-only tools', () => {
    function simpleRun(args: Record<string, unknown>) {
      return args;
    }

    const simpleTool = new LangchainTool({
      name: 'simple_runner',
      description: 'Simple convention-based tool',
      run: simpleRun,
    });

    const decl = simpleTool._getDeclaration();
    expect(decl).toEqual({
      name: 'simple_runner',
      description: 'Simple convention-based tool',
    });
  });

  it('executes _run, _call, invoke, or run via runAsync and rejects invalid tool objects', async () => {
    const invokeSpy = vi.fn(
      async (args: Record<string, unknown>) => `invoked:${args['input']}`,
    );
    const runnableTool = new LangchainTool({
      name: 'runnable_tool',
      description: 'Uses invoke',
      argsSchema: z.object({input: z.string()}),
      invoke: invokeSpy,
    });

    const result = await runnableTool.runAsync({
      args: {input: 'hello'},
      toolContext: emptyContext,
    });
    expect(result).toBe('invoked:hello');
    expect(invokeSpy).toHaveBeenCalledWith({input: 'hello'}, emptyContext);

    expect(
      () =>
        new LangchainTool({
          name: 'invalid_tool',
        } as LangchainToolLike),
    ).toThrow(TypeError);
  });

  it('wraps schema extraction errors in _getDeclaration with cause', () => {
    const schemaError = new Error('broken modelJsonSchema');
    const brokenTool = new LangchainTool({
      name: 'broken_schema_tool',
      description: 'Throws during schema extraction',
      argsSchema: {
        modelJsonSchema: () => {
          throw schemaError;
        },
      },
      _run: () => 'ok',
    });

    let caughtError: Error | undefined;
    try {
      brokenTool._getDeclaration();
    } catch (e: unknown) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError?.message).toBe(
      'Failed to build function declaration for Langchain tool: broken modelJsonSchema',
    );
    expect(caughtError?.cause).toBe(schemaError);
  });

  describe('with a StructuredTool-like class', () => {
    interface SearchInput {
      query: string;
    }

    interface FakeRunnableConfig {
      tags?: string[];
    }

    interface FakeRunManager {
      getChild(): unknown;
    }

    class FakeStructuredTool {
      name = 'fake_search';
      description = 'Searches with a typed input';
      schema = z.object({query: z.string()});

      protected _call(input: SearchInput, runManager?: FakeRunManager): string {
        runManager?.getChild();
        return `found:${input.query}`;
      }

      async invoke(
        input: SearchInput,
        options?: FakeRunnableConfig,
      ): Promise<string> {
        return `${this._call(input)}:${options?.tags?.length ?? 0}`;
      }
    }

    it('accepts the class instance without a cast and calls invoke', async () => {
      const directTool = new LangchainTool(new FakeStructuredTool());
      const configTool = new LangchainTool({tool: new FakeStructuredTool()});

      expect(directTool.name).toBe('fake_search');
      expect(configTool.name).toBe('fake_search');
      expect(
        await directTool.runAsync({
          args: {query: 'adk'},
          toolContext: emptyContext,
        }),
      ).toBe('found:adk:0');
      expect(
        await configTool.runAsync({
          args: {query: 'adk'},
          toolContext: emptyContext,
        }),
      ).toBe('found:adk:0');
    });
  });

  it('calls invoke instead of _call when a tool has both', async () => {
    const invokeSpy = vi.fn(
      async (args: Record<string, unknown>) => `invoked:${args['input']}`,
    );
    const callSpy = vi.fn(() => 'called');
    const tool = new LangchainTool({
      name: 'priority_tool',
      description: 'Has invoke and _call',
      schema: z.object({input: z.string()}),
      invoke: invokeSpy,
      _call: callSpy,
    });

    const result = await tool.runAsync({
      args: {input: 'hello'},
      toolContext: emptyContext,
    });

    expect(result).toBe('invoked:hello');
    expect(invokeSpy).toHaveBeenCalledWith({input: 'hello'}, emptyContext);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('parses the input only once when invoke validates it', async () => {
    const schema = z.object({n: z.string().transform((s) => s.length)});
    const invokeSpy = vi.fn(
      async (args: Record<string, unknown>) =>
        (await schema.parseAsync(args)).n,
    );
    const tool = new LangchainTool({
      name: 'transform_tool',
      description: 'Parses its own input',
      schema,
      invoke: invokeSpy,
    });

    const result = await tool.runAsync({
      args: {n: 'abc'},
      toolContext: emptyContext,
    });

    expect(result).toBe(3);
    expect(invokeSpy).toHaveBeenCalledWith({n: 'abc'}, emptyContext);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it('builds the declaration from the schema of a tool with invoke', () => {
    const tool = new LangchainTool({
      name: 'invoke_schema_tool',
      description: 'Has invoke and a schema',
      schema: z.object({query: z.string()}),
      invoke: async (args: Record<string, unknown>) => args['query'],
    });

    expect(tool._getDeclaration()).toEqual({
      name: 'invoke_schema_tool',
      description: 'Has invoke and a schema',
      parameters: {
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING}},
        required: ['query'],
      },
    });
  });

  it('parses the input before calling a runner that does not validate', async () => {
    const runSpy = vi.fn((args: Record<string, unknown>) => args['n']);
    const tool = new LangchainTool({
      name: 'legacy_transform_tool',
      description: 'Does not parse its own input',
      schema: z.object({n: z.string().transform((s) => s.length)}),
      _run: runSpy,
    });

    const result = await tool.runAsync({
      args: {n: 'abc'},
      toolContext: emptyContext,
    });

    expect(result).toBe(3);
    expect(runSpy).toHaveBeenCalledWith({n: 3}, emptyContext);
  });

  it('calls func with the arguments only', async () => {
    const funcSpy = vi.fn(
      (args: Record<string, unknown>) => `func:${args['input']}`,
    );
    const tool = new LangchainTool({
      name: 'func_tool',
      description: 'Wraps a function',
      func: funcSpy,
    });

    const result = await tool.runAsync({
      args: {input: 'hello'},
      toolContext: emptyContext,
    });

    expect(result).toBe('func:hello');
    expect(funcSpy).toHaveBeenCalledWith({input: 'hello'});
  });

  it('does not mark fields as required when every schema field is optional', () => {
    const tool = new LangchainTool({
      name: 'optional_tool',
      description: 'All fields are optional',
      schema: z.object({a: z.string().optional(), b: z.number().optional()}),
      _run: () => 'ok',
    });

    expect(tool._getDeclaration()).toEqual({
      name: 'optional_tool',
      description: 'All fields are optional',
      parameters: {
        type: Type.OBJECT,
        properties: {
          a: {type: Type.STRING},
          b: {type: Type.NUMBER},
        },
      },
    });
  });

  it('does not mark defaulted or nullable fields as required', () => {
    const tool = new LangchainTool({
      name: 'mixed_tool',
      description: 'Has defaulted and nullable fields',
      schema: z.object({
        query: z.string(),
        mode: z.string().default('fast'),
        note: z.string().nullable(),
      }),
      _run: () => 'ok',
    });

    expect(tool._getDeclaration().parameters?.required).toEqual(['query']);
  });

  it('builds no parameters for schemas without properties', () => {
    const schemas = [{type: 'object'}, {type: 'string'}, z.object({})];
    for (const schema of schemas) {
      const tool = new LangchainTool({
        name: 'no_params_tool',
        description: 'Has no parameters',
        schema,
        _run: () => 'ok',
      });

      expect(tool._getDeclaration()).toEqual({
        name: 'no_params_tool',
        description: 'Has no parameters',
      });
    }
  });

  describe('with the Vertex AI variant', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('builds the same normalized declaration as the Gemini API variant', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);
      const tool = new LangchainTool({
        name: 'vertex_tool',
        description: 'Runs under Vertex AI',
        schema: z.object({
          query: z.string().describe('Search query'),
          limit: z.number().optional(),
        }),
        _call: () => 'ok',
      });

      expect(tool.apiVariant).toBe(GoogleLLMVariant.VERTEX_AI);
      expect(tool._getDeclaration()).toEqual({
        name: 'vertex_tool',
        description: 'Runs under Vertex AI',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {type: Type.STRING, description: 'Search query'},
            limit: {type: Type.NUMBER},
          },
          required: ['query'],
        },
      });
    });
  });

  it('builds FunctionDeclaration from an argsSchema with toJsonSchema', () => {
    const tool = new LangchainTool({
      name: 'json_schema_tool',
      description: 'Uses toJsonSchema',
      argsSchema: {
        toJsonSchema: () => ({
          type: 'object',
          properties: {q: {type: 'string'}, n: {type: 'integer'}},
          required: ['q'],
        }),
      },
      _run: () => 'ok',
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
