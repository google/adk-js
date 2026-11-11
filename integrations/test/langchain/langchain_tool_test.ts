/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool} from '@google/adk';
import {
  isLangchainTool,
  LangchainTool,
  type LangchainToolLike,
} from '@google/adk-integrations';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
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
});
