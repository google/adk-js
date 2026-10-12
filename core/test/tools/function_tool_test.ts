/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, FunctionTool, isFunctionTool} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {
  buildFunctionDeclarationForLangchain,
  buildFunctionDeclarationForParamsForCrewai,
  buildFunctionDeclarationUtil,
  GoogleLLMVariant,
} from '@google/adk';

describe('FunctionTool', () => {
  let emptyContext: Context;
  beforeEach(() => {
    emptyContext = {} as Context;
  });

  describe('isFunctionTool', () => {
    it('returns true for FunctionTool instances', () => {
      const tool = new FunctionTool({
        name: 'test',
        description: 'test',
        execute: () => {},
      });
      expect(isFunctionTool(tool)).toBe(true);
    });

    it('returns false for plain objects', () => {
      expect(isFunctionTool({})).toBe(false);
      expect(isFunctionTool({name: 'test'})).toBe(false);
    });

    it('returns false for null or undefined', () => {
      expect(isFunctionTool(null)).toBe(false);
      expect(isFunctionTool(undefined)).toBe(false);
    });
  });

  describe('zod v3', () => {
    it('computes the correct declaration', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
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
      async function add({a, b}: {a: number; b: number}) {
        return a + b;
      }

      const addTool = new FunctionTool({
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with lambda functions', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
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

    it('works with a static method from a class', async () => {
      class Calculator {
        static add({a, b}: {a: number; b: number}) {
          return a + b;
        }
      }

      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
        }),
        execute: Calculator.add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
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
        parameters: z3.object({a: z3.number()}),
        execute: counter.incrementBy.bind(counter),
      });

      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);
      expect(counter.count).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
      expect(counter.count).toEqual(3);
    });

    it('works with default values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number().default(2),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with optional values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number().optional(),
        }),
        execute: async ({a, b}) => {
          return b ? a + b : a;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
    });

    it('works with array values', async () => {
      const concatStringTool = new FunctionTool({
        name: 'concat_string',
        description: 'Concatenates an array of strings.',
        parameters: z3.object({
          strings: z3.array(z3.string()),
        }),
        execute: async ({strings}) => {
          return strings.join(',');
        },
      });
      const result = await concatStringTool.runAsync({
        args: {strings: ['a', 'b', 'c']},
        toolContext: emptyContext,
      });
      expect(result).toEqual('a,b,c');
    });

    it('infers types from zod schema without explicit annotations', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z3.object({
          a: z3.number(),
          b: z3.number(),
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
        parameters: z4.object({}),
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

  describe('zod v4', () => {
    it('computes the correct declaration', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
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
      async function add({a, b}: {a: number; b: number}) {
        return a + b;
      }

      const addTool = new FunctionTool({
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with lambda functions', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
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

    it('works with a static method from a class', async () => {
      class Calculator {
        static add({a, b}: {a: number; b: number}) {
          return a + b;
        }
      }

      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
        }),
        execute: Calculator.add,
      });

      const result = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
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
        parameters: z4.object({a: z4.number()}),
        execute: counter.incrementBy.bind(counter),
      });

      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);
      expect(counter.count).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
      expect(counter.count).toEqual(3);
    });

    it('works with default values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number().default(2),
        }),
        execute: async ({a, b}) => {
          return a + b;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(3);
    });

    it('works with optional values', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number().optional(),
        }),
        execute: async ({a, b}) => {
          return b ? a + b : a;
        },
      });
      const result = await addTool.runAsync({
        args: {a: 1},
        toolContext: emptyContext,
      });
      expect(result).toEqual(1);

      const result2 = await addTool.runAsync({
        args: {a: 1, b: 2},
        toolContext: emptyContext,
      });
      expect(result2).toEqual(3);
    });

    it('works with array values', async () => {
      const concatStringTool = new FunctionTool({
        name: 'concat_string',
        description: 'Concatenates an array of strings.',
        parameters: z4.object({
          strings: z4.array(z4.string()),
        }),
        execute: async ({strings}) => {
          return strings.join(',');
        },
      });
      const result = await concatStringTool.runAsync({
        args: {strings: ['a', 'b', 'c']},
        toolContext: emptyContext,
      });
      expect(result).toEqual('a,b,c');
    });

    it('infers types from zod schema without explicit annotations', async () => {
      const addTool = new FunctionTool({
        name: 'add',
        description: 'Adds two numbers.',
        parameters: z4.object({
          a: z4.number(),
          b: z4.number(),
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
        parameters: z4.object({}),
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

  describe('response schema and _callLive', () => {
    it('includes response schema in _getDeclaration when configured', () => {
      const toolWithZodResponse = new FunctionTool({
        name: 'get_weather',
        description: 'Gets weather.',
        parameters: z4.object({city: z4.string()}),
        response: z4.object({
          temperature: z4.number(),
          condition: z4.string(),
        }),
        execute: async ({city}) => ({temperature: 22, condition: city}),
      });

      const decl = toolWithZodResponse._getDeclaration();
      expect(decl.response).toEqual({
        type: Type.OBJECT,
        properties: {
          temperature: {type: Type.NUMBER},
          condition: {type: Type.STRING},
        },
        required: ['temperature', 'condition'],
      });

      const toolWithoutResponse = new FunctionTool({
        name: 'ping',
        description: 'Pings.',
        execute: () => 'pong',
      });
      expect(toolWithoutResponse._getDeclaration().response).toBeUndefined();
    });

    it('streams async generator items and injects inputStream in _callLive', async () => {
      const receivedStreams: unknown[] = [];
      const liveTool = new FunctionTool({
        name: 'live_stream_tool',
        description: 'Streams live chunks.',
        parameters: z4.object({
          prefix: z4.string(),
        }),
        execute: async function* (args: Record<string, unknown>) {
          receivedStreams.push(args['inputStream']);
          yield `${args['prefix']}-1`;
          yield `${args['prefix']}-2`;
        },
      });

      const fakeStream = {id: 'live-request-queue'};
      const callerArgs = {prefix: 'chunk'};
      const chunks: unknown[] = [];
      for await (const item of liveTool._callLive({
        args: callerArgs,
        toolContext: emptyContext,
        invocationContext: {
          activeStreamingTools: {
            live_stream_tool: {stream: fakeStream},
          },
        } as unknown as Context['invocationContext'],
      })) {
        chunks.push(item);
      }

      expect(chunks).toEqual(['chunk-1', 'chunk-2']);
      expect(receivedStreams).toEqual([fakeStream]);
      expect(callerArgs).toEqual({prefix: 'chunk'});
    });

    it('yields single resolved value and validates args in _callLive', async () => {
      const singleValueTool = new FunctionTool({
        name: 'single_live_tool',
        description: 'Returns single value.',
        parameters: z4.object({count: z4.number()}),
        execute: async ({count}) => count * 2,
      });

      const results: unknown[] = [];
      for await (const item of singleValueTool._callLive({
        args: {count: 5},
        toolContext: emptyContext,
        invocationContext: {} as unknown as Context['invocationContext'],
      })) {
        results.push(item);
      }
      expect(results).toEqual([10]);

      const invalidGenerator = singleValueTool._callLive({
        args: {count: 'not-a-number'},
        toolContext: emptyContext,
        invocationContext: {} as unknown as Context['invocationContext'],
      });
      await expect(invalidGenerator.next()).rejects.toThrow();
    });
  });

  describe('declaration building utilities', () => {
    it('test_string_input', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'Simple function description',
        function simpleFunction() {},
        {
          properties: {
            input_str: {type: 'str'},
          },
          required: ['input_str'],
        },
      );
      expect(decl).toEqual({
        name: 'simple_function',
        description: 'Simple function description',
        parameters: {
          type: Type.OBJECT,
          properties: {input_str: {type: Type.STRING}},
          required: ['input_str'],
        },
      });
    });

    it('test_int_input', () => {
      const decl = buildFunctionDeclarationUtil(
        true,
        'simple_function',
        'Int function',
        Object.assign(function simpleFunction() {}, {returnType: 'int'}),
        {
          properties: {
            input_str: {type: 'int'},
          },
          required: ['input_str'],
        },
      );
      expect(decl).toEqual({
        name: 'simple_function',
        description: 'Int function',
        parameters: {
          type: Type.OBJECT,
          properties: {input_str: {type: Type.INTEGER}},
          required: ['input_str'],
        },
        response: {type: Type.INTEGER},
      });
    });

    it('test_float_input', () => {
      const decl = buildFunctionDeclarationUtil(
        true,
        'simple_function',
        'Float function',
        Object.assign(function simpleFunction() {}, {returnType: 'float'}),
        {
          properties: {
            input_str: {type: 'float'},
          },
          required: ['input_str'],
        },
      );
      expect(decl).toEqual({
        name: 'simple_function',
        description: 'Float function',
        parameters: {
          type: Type.OBJECT,
          properties: {input_str: {type: Type.NUMBER}},
          required: ['input_str'],
        },
        response: {type: Type.NUMBER},
      });
    });

    it('test_bool_input', () => {
      const decl = buildFunctionDeclarationUtil(
        true,
        'simple_function',
        'Bool function',
        Object.assign(function simpleFunction() {}, {returnType: 'bool'}),
        {
          properties: {
            input_str: {type: 'bool'},
          },
          required: ['input_str'],
        },
      );
      expect(decl).toEqual({
        name: 'simple_function',
        description: 'Bool function',
        parameters: {
          type: Type.OBJECT,
          properties: {input_str: {type: Type.BOOLEAN}},
          required: ['input_str'],
        },
        response: {type: Type.BOOLEAN},
      });
    });

    it('test_array_input', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'Array function',
        function simpleFunction() {},
        {
          properties: {
            input_str: {type: 'List', items: {type: 'str'}},
            tuple_items: {type: 'tuple', items: {type: 'int'}},
          },
          required: ['input_str', 'tuple_items'],
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input_str: {type: Type.ARRAY, items: {type: Type.STRING}},
          tuple_items: {type: Type.ARRAY, items: {type: Type.INTEGER}},
        },
        required: ['input_str', 'tuple_items'],
      });
    });

    it('test_dict_input', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'Dict function',
        function simpleFunction() {},
        {
          properties: {
            input_str: {type: 'Dict'},
            any_val: {type: 'Any'},
          },
          required: ['input_str'],
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input_str: {type: Type.OBJECT},
          any_val: {type: Type.TYPE_UNSPECIFIED},
        },
        required: ['input_str'],
      });
    });

    it('test_basemodel_input', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'Object schema input',
        function simpleFunction() {},
        {
          properties: {
            input: {
              type: 'object',
              properties: {
                input_str: {type: 'str'},
              },
            },
          },
          required: ['input'],
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input: {
            type: Type.OBJECT,
            properties: {
              input_str: {type: Type.STRING},
            },
          },
        },
        required: ['input'],
      });
    });

    it('test_toolcontext_ignored', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'No parameters when empty',
        function simpleFunction() {},
        {properties: {}},
      );
      expect(decl).toEqual({
        name: 'simple_function',
        description: 'No parameters when empty',
      });
      expect(decl.parameters).toBeUndefined();
    });

    it('test_basemodel', () => {
      const decl = buildFunctionDeclarationUtil(
        true,
        'SimpleFunction',
        'Standalone schema',
        function simpleFunction() {},
        {
          properties: {
            input_str: {type: 'string'},
          },
          required: ['input_str'],
        },
      );
      expect(decl).toEqual({
        name: 'SimpleFunction',
        description: 'Standalone schema',
        parameters: {
          type: Type.OBJECT,
          properties: {
            input_str: {type: Type.STRING},
          },
          required: ['input_str'],
        },
        response: {type: Type.TYPE_UNSPECIFIED},
      });
    });

    it('test_nested_basemodel_input', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'Nested object schema input',
        function simpleFunction() {},
        {
          properties: {
            input: {
              type: 'object',
              properties: {
                child: {
                  type: 'object',
                  properties: {
                    input_str: {type: 'str'},
                  },
                },
              },
            },
          },
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input: {
            type: Type.OBJECT,
            properties: {
              child: {
                type: Type.OBJECT,
                properties: {
                  input_str: {type: Type.STRING},
                },
              },
            },
          },
        },
      });
    });

    it('test_basemodel_with_nested_basemodel', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'CustomInput',
        'Custom nested schema',
        undefined,
        {
          properties: {
            child: {
              type: 'object',
              properties: {
                input_str: {type: 'string'},
              },
            },
          },
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          child: {
            type: Type.OBJECT,
            properties: {
              input_str: {type: Type.STRING},
            },
          },
        },
      });
    });

    it('test_list', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'List of strings and dicts',
        function simpleFunction() {},
        {
          properties: {
            input_str: {type: 'list', items: {type: 'str'}},
            input_dir: {type: 'list', items: {type: 'Dict'}},
          },
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input_str: {type: Type.ARRAY, items: {type: Type.STRING}},
          input_dir: {type: Type.ARRAY, items: {type: Type.OBJECT}},
        },
      });
    });

    it('test_basemodel_list', () => {
      const decl = buildFunctionDeclarationUtil(
        false,
        'simple_function',
        'List of nested objects',
        function simpleFunction() {},
        {
          properties: {
            input_str: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  child: {
                    type: 'object',
                    properties: {
                      input_str: {type: 'string'},
                    },
                  },
                },
              },
            },
          },
        },
      );
      expect(decl.parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          input_str: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                child: {
                  type: Type.OBJECT,
                  properties: {
                    input_str: {type: Type.STRING},
                  },
                },
              },
            },
          },
        },
      });
    });

    it('normalizes nullable, default, title, and anyOf fields for CrewAI and LangChain schemas', () => {
      const crewaiSchema = {
        properties: {
          mandatory_str: {type: 'string', title: 'Mandatory'},
          nullable_int: {
            anyOf: [{type: 'integer'}, {type: 'null'}],
            default: null,
          },
          default_bool: {type: 'boolean', default: true},
        },
      };

      const geminiDecl = buildFunctionDeclarationForParamsForCrewai(
        false,
        'crew_tool',
        'Crew description',
        function run() {},
        crewaiSchema,
      );
      expect(geminiDecl).toEqual({
        name: 'crew_tool',
        description: 'Crew description',
        parameters: {
          type: Type.OBJECT,
          properties: {
            mandatory_str: {type: Type.STRING},
            nullable_int: {type: Type.INTEGER},
            default_bool: {type: Type.BOOLEAN},
          },
          required: ['mandatory_str'],
        },
      });
      expect(geminiDecl.response).toBeUndefined();

      const vertexDecl = buildFunctionDeclarationForLangchain(
        true,
        'lc_tool',
        'LC description',
        function _run() {},
        crewaiSchema.properties,
      );
      expect(vertexDecl.name).toBe('lc_tool');
      expect(vertexDecl.parameters?.required).toEqual(['mandatory_str']);
      expect(vertexDecl.parameters?.properties?.['nullable_int']).toEqual({
        type: Type.INTEGER,
        anyOf: [{type: Type.INTEGER}],
        nullable: true,
        default: null,
      });
      expect(vertexDecl.response).toEqual({type: Type.TYPE_UNSPECIFIED});
      expect(GoogleLLMVariant.VERTEX_AI).toBe('VERTEX_AI');
    });
  });
});
