/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { FunctionTool, ToolContext } from '@google/adk'
import { Type } from '@google/genai'
import { z } from 'zod'

describe('FunctionTool', () => {
  let emptyContext: ToolContext;
  beforeEach(() => {
    emptyContext = {} as ToolContext;
  });

  it('computes the correct declaration', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({a, b}) => {
        return a + b;
      },
    });

    const declaration = addTool._getDeclaration();
    expect(declaration.name).toEqual('add');
    expect(declaration.description).toEqual('Adds two numbers.');
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        a: {type: Type.NUMBER},
        b: {type: Type.NUMBER},
      },
      required: ['a', 'b'],
    });
  });

  it('works with named functions', async () => {
    async function add({a, b}: {a: number, b: number}) {
      return a + b;
    }

    const addTool = new FunctionTool({
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: add,
    });

    const result =
        await addTool.runAsync({args: {a: 1, b: 2}, toolContext: emptyContext});
    expect(result).toEqual(3);
  });

  it('works with lambda functions', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({a, b}) => {
        return a + b;
      },
    });
    const result =
        await addTool.runAsync({args: {a: 1, b: 2}, toolContext: emptyContext});
    expect(result).toEqual(3);
  });

  it('works with a static method from a class', async () => {
    class Calculator {
      static add({a, b}: {a: number, b: number}) {
        return a + b;
      }
    }

    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: Calculator.add,
    });

    const result =
        await addTool.runAsync({args: {a: 1, b: 2}, toolContext: emptyContext});
    expect(result).toEqual(3);
  });

  it('works with an stateful instance method from an object', async () => {
    class Counter {
      count = 0;
      incrementBy({a}: {a: number}) {
        this.count += a;
        return this.count;
      }
    }

    const counter = new Counter();
    const addTool = new FunctionTool({
      name: 'incrementBy',
      description: 'Increments a counter by the given number.',
      parameters: z.object({a: z.number()}),
      execute: counter.incrementBy.bind(counter),
    });

    const result =
        await addTool.runAsync({args: {a: 1}, toolContext: emptyContext});
    expect(result).toEqual(1);
    expect(counter.count).toEqual(1);

    const result2 =
        await addTool.runAsync({args: {a: 2}, toolContext: emptyContext});
    expect(result2).toEqual(3);
    expect(counter.count).toEqual(3);
  });

  it('works with default values', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number().default(2),
      }),
      execute: async ({a, b}) => {
        return a + b;
      },
    });
    const result =
        await addTool.runAsync({args: {a: 1}, toolContext: emptyContext});
    expect(result).toEqual(3);
  });

  it('works with optional values', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number().optional(),
      }),
      execute: async ({a, b}) => {
        return b ? a + b : a;
      },
    });
    const result =
        await addTool.runAsync({args: {a: 1}, toolContext: emptyContext});
    expect(result).toEqual(1);

    const result2 =
        await addTool.runAsync({args: {a: 1, b: 2}, toolContext: emptyContext});
    expect(result2).toEqual(3);
  });

  it('works with array values', async () => {
    const concatStringTool = new FunctionTool({
      name: 'concat_string',
      description: 'Concatenates an array of strings.',
      parameters: z.object({
        strings: z.array(z.string()),
      }),
      execute: async ({strings}) => {
        return strings.join(',');
      },
    });
    const result = await concatStringTool.runAsync(
        {args: {strings: ['a', 'b', 'c']}, toolContext: emptyContext});
    expect(result).toEqual('a,b,c');
  });

  it('infers types from zod schema without explicit annotations', async () => {
    const addTool = new FunctionTool({
      name: 'add',
      description: 'Adds two numbers.',
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({a, b}) => {
        return a + b;
      },
    });

    const result = await addTool.runAsync({
      args: {a: 1, b: 2},
      toolContext: emptyContext,
    });
    expect(result).toEqual(3);
  });

  it('wraps errors from execute function', async () => {
    const tool = new FunctionTool({
      name: 'errorTool',
      description: 'Throws an error.',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('Test error');
      },
    });
    try {
      await tool.runAsync({
        args: {},
        toolContext: emptyContext,
      });
    } catch (e) {
      expect((e as Error).message).toContain(
        "Error in tool 'errorTool': Test error",
      );
    }
  });
});
