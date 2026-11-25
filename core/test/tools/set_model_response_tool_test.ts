/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  isSetModelResponseTool,
  LlmAgent,
  PluginManager,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SetModelResponseTool,
} from '@google/adk';
import {type Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z} from 'zod/v4';

const personSchema = z.object({
  name: z.string().describe("A person's name"),
  age: z.number().int().describe("A person's age"),
  city: z.string().describe('The city they live in'),
});

const complexSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.string()).default({}),
  isActive: z.boolean().default(true),
  note: z.string().nullable().optional(),
});

async function createTestToolContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'testApp',
    userId: 'testUser',
  });
  const agent = new LlmAgent({
    name: 'testAgent',
    model: 'gemini-flash-latest',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-set-model-response',
    agent,
    session,
    sessionService,
    pluginManager: new PluginManager(),
  });
  return new Context({invocationContext});
}

describe('SetModelResponseTool', () => {
  it('identifies instances via isSetModelResponseTool and rejects nullish schemas', () => {
    const tool = new SetModelResponseTool(personSchema);
    const fnTool = new FunctionTool({
      name: 'plainFn',
      description: 'Plain tool',
      execute: () => 'ok',
    });

    expect(SET_MODEL_RESPONSE_TOOL_NAME).toBe('set_model_response');
    expect(tool.name).toBe(SET_MODEL_RESPONSE_TOOL_NAME);
    expect(tool.outputSchema).toBe(personSchema);
    expect(tool.description).toContain('Set your final response');

    expect(isSetModelResponseTool(tool)).toBe(true);
    expect(isSetModelResponseTool(fnTool)).toBe(false);
    expect(isSetModelResponseTool({})).toBe(false);
    expect(isSetModelResponseTool(null)).toBe(false);
    expect(isSetModelResponseTool(undefined)).toBe(false);

    expect(
      () =>
        new SetModelResponseTool(
          undefined as unknown as z.ZodObject<z.ZodRawShape>,
        ),
    ).toThrow(TypeError);
    expect(
      () =>
        new SetModelResponseTool(null as unknown as z.ZodObject<z.ZodRawShape>),
    ).toThrow(TypeError);
  });

  it('builds declarations preserving descriptions, nested descriptions, optionality, and defaults', () => {
    const personDecl = new SetModelResponseTool(personSchema)._getDeclaration();
    expect(personDecl.name).toBe('set_model_response');
    expect(personDecl.parameters?.properties?.['name']?.description).toBe(
      "A person's name",
    );
    expect(personDecl.parameters?.properties?.['age']?.description).toBe(
      "A person's age",
    );
    expect(personDecl.parameters?.properties?.['city']?.description).toBe(
      'The city they live in',
    );
    expect(personDecl.parameters?.required).toEqual(['name', 'age', 'city']);

    const complexDecl = new SetModelResponseTool(
      complexSchema,
    )._getDeclaration();
    expect(complexDecl.parameters?.required).toEqual(['id', 'title']);
    expect(complexDecl.parameters?.properties?.['tags']?.default).toEqual([]);
    expect(complexDecl.parameters?.properties?.['metadata']?.default).toEqual(
      {},
    );
    expect(complexDecl.parameters?.properties?.['isActive']?.default).toBe(
      true,
    );

    const nestedSchema = z.object({
      name: z.string().describe("User's name"),
      address: z
        .object({
          street: z.string().describe('Street address'),
          city: z.string().describe('City name'),
        })
        .describe("User's address"),
      previousAddresses: z
        .array(
          z.object({
            street: z.string().describe('Past street'),
          }),
        )
        .default([])
        .describe('Past addresses'),
    });
    const nestedDecl = new SetModelResponseTool(nestedSchema)._getDeclaration();
    expect(nestedDecl.parameters?.properties?.['name']?.description).toBe(
      "User's name",
    );
    expect(nestedDecl.parameters?.properties?.['address']?.description).toBe(
      "User's address",
    );
    expect(
      nestedDecl.parameters?.properties?.['address']?.properties?.['street']
        ?.description,
    ).toBe('Street address');
    expect(
      nestedDecl.parameters?.properties?.['previousAddresses']?.items
        ?.properties?.['street']?.description,
    ).toBe('Past street');
  });

  it('supports Zod v3 objects and genai Type.OBJECT schemas directly', async () => {
    const zodV3Schema = z3.object({
      title: z3.string().describe('Result title'),
      count: z3.number().optional(),
    });
    const zodV3Tool = new SetModelResponseTool(zodV3Schema);
    const zodV3Decl = zodV3Tool._getDeclaration();
    expect(zodV3Decl.parameters?.required).toEqual(['title']);
    expect(zodV3Decl.parameters?.properties?.['title']?.description).toBe(
      'Result title',
    );

    const genaiObjectSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        answer: {type: Type.STRING, description: 'Structured answer'},
        confidence: {type: Type.NUMBER},
      },
      required: ['answer'],
    };
    const genaiTool = new SetModelResponseTool(genaiObjectSchema);
    const genaiDecl = genaiTool._getDeclaration();
    expect(genaiDecl.parameters).toEqual(genaiObjectSchema);
    expect(genaiDecl.parameters).not.toBe(genaiObjectSchema);

    const toolContext = await createTestToolContext();
    const result = await genaiTool.runAsync({
      args: {answer: 'forty-two', extra: null},
      toolContext,
    });
    expect(result).toEqual({answer: 'forty-two'});
    expect(toolContext.actions.setModelResponse).toEqual({answer: 'forty-two'});
  });

  it('validates object responses, strips nullish keys, and stores actions.setModelResponse', async () => {
    const tool = new SetModelResponseTool(complexSchema);
    const toolContext = await createTestToolContext();

    const result = await tool.runAsync({
      args: {
        id: 123,
        title: 'Test Item',
        tags: ['tag1', 'tag2'],
        metadata: {key: 'value'},
        isActive: false,
        note: null,
      },
      toolContext,
    });

    expect(result).toEqual({
      id: 123,
      title: 'Test Item',
      tags: ['tag1', 'tag2'],
      metadata: {key: 'value'},
      isActive: false,
    });
    expect(result).not.toHaveProperty('note');
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('returns validation feedback without setting actions.setModelResponse on invalid or missing args', async () => {
    const refinedSchema = personSchema.refine((val) => val.age >= 18, {
      message: 'Age must be at least 18',
      path: ['age'],
    });
    const tool = new SetModelResponseTool(refinedSchema);

    const wrongTypeContext = await createTestToolContext();
    const wrongTypeResult = (await tool.runAsync({
      args: {name: 'Bob', age: 'notANumber', city: 'Portland'},
      toolContext: wrongTypeContext,
    })) as {error: string};
    expect(wrongTypeResult.error).toContain('Validation Error found:');
    expect(wrongTypeResult.error).toContain('age');
    expect(wrongTypeResult.error).toContain(
      'Recall the set_model_response function correctly',
    );
    expect(wrongTypeContext.actions.setModelResponse).toBeUndefined();

    const missingFieldContext = await createTestToolContext();
    const missingFieldResult = (await tool.runAsync({
      args: {name: 'Charlie', city: 'Denver'},
      toolContext: missingFieldContext,
    })) as {error: string};
    expect(missingFieldResult.error).toContain('Validation Error found:');
    expect(missingFieldResult.error).toContain('age');
    expect(missingFieldContext.actions.setModelResponse).toBeUndefined();

    const refineContext = await createTestToolContext();
    const refineResult = (await tool.runAsync({
      args: {name: 'Dana', age: 15, city: 'Austin'},
      toolContext: refineContext,
    })) as {error: string};
    expect(refineResult.error).toContain('Age must be at least 18');
    expect(refineContext.actions.setModelResponse).toBeUndefined();
  });

  it('wraps array-of-object schemas under items and validates elements', async () => {
    const itemSchema = z.object({
      id: z.number().int().describe('Item ID'),
      name: z.string().describe('Item name'),
      note: z.string().nullable().optional(),
    });
    const zodArrayTool = new SetModelResponseTool(z.array(itemSchema));

    const decl = zodArrayTool._getDeclaration();
    expect(decl.parameters?.type).toBe(Type.OBJECT);
    expect(decl.parameters?.required).toEqual(['items']);
    expect(decl.parameters?.properties?.['items']?.type).toBe(Type.ARRAY);
    expect(
      decl.parameters?.properties?.['items']?.items?.properties?.['id']
        ?.description,
    ).toBe('Item ID');

    const validContext = await createTestToolContext();
    const validResult = await zodArrayTool.runAsync({
      args: {
        items: [
          {id: 1, name: 'Item 1', note: null},
          {id: 2, name: 'Item 2'},
        ],
      },
      toolContext: validContext,
    });
    expect(validResult).toEqual([
      {id: 1, name: 'Item 1'},
      {id: 2, name: 'Item 2'},
    ]);
    expect(validContext.actions.setModelResponse).toEqual(validResult);

    const emptyContext = await createTestToolContext();
    expect(
      await zodArrayTool.runAsync({
        args: {items: []},
        toolContext: emptyContext,
      }),
    ).toEqual([]);
    expect(emptyContext.actions.setModelResponse).toEqual([]);

    const invalidContext = await createTestToolContext();
    const invalidResult = (await zodArrayTool.runAsync({
      args: {items: [{id: 'bad', name: 'Item 1'}]},
      toolContext: invalidContext,
    })) as {error: string};
    expect(invalidResult.error).toContain('Validation Error found:');
    expect(invalidContext.actions.setModelResponse).toBeUndefined();

    const genaiArrayTool = new SetModelResponseTool({
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {id: {type: Type.INTEGER}},
        required: ['id'],
      },
    });
    expect(genaiArrayTool._getDeclaration().parameters?.required).toEqual([
      'items',
    ]);
    const genaiCtx = await createTestToolContext();
    expect(
      await genaiArrayTool.runAsync({
        args: {items: [{id: 7}]},
        toolContext: genaiCtx,
      }),
    ).toEqual([{id: 7}]);
  });

  it('wraps non-object scalar, array-of-string, and record schemas under response', async () => {
    const stringArrayTool = new SetModelResponseTool(z.array(z.string()));
    const stringArrayDecl = stringArrayTool._getDeclaration();
    expect(stringArrayDecl.parameters?.required).toEqual(['response']);
    expect(stringArrayDecl.parameters?.properties?.['response']?.type).toBe(
      Type.ARRAY,
    );

    const ctx1 = await createTestToolContext();
    expect(
      await stringArrayTool.runAsync({
        args: {response: ['apple', 'banana']},
        toolContext: ctx1,
      }),
    ).toEqual(['apple', 'banana']);
    expect(ctx1.actions.setModelResponse).toEqual(['apple', 'banana']);

    const recordTool = new SetModelResponseTool(
      z.record(z.string(), z.number()),
    );
    expect(recordTool._getDeclaration().parameters?.required).toEqual([
      'response',
    ]);
    const ctx2 = await createTestToolContext();
    expect(
      await recordTool.runAsync({
        args: {response: {a: 1, b: 2}},
        toolContext: ctx2,
      }),
    ).toEqual({a: 1, b: 2});

    const scalarTool = new SetModelResponseTool({type: Type.STRING});
    expect(scalarTool._getDeclaration().parameters?.required).toEqual([
      'response',
    ]);
    const ctx3 = await createTestToolContext();
    expect(
      await scalarTool.runAsync({
        args: {response: 'final text'},
        toolContext: ctx3,
      }),
    ).toBe('final text');
    expect(ctx3.actions.setModelResponse).toBe('final text');
  });

  it('handles repeated executions independently', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const context1 = await createTestToolContext();
    const context2 = await createTestToolContext();

    const result1 = await tool.runAsync({
      args: {name: 'First', age: 20, city: 'CityOne'},
      toolContext: context1,
    });
    const result2 = await tool.runAsync({
      args: {name: 'Second', age: 30, city: 'CityTwo'},
      toolContext: context2,
    });

    expect(result1).toEqual({name: 'First', age: 20, city: 'CityOne'});
    expect(result2).toEqual({name: 'Second', age: 30, city: 'CityTwo'});
    expect(context1.actions.setModelResponse).toEqual(result1);
    expect(context2.actions.setModelResponse).toEqual(result2);
  });

  it('unwraps Zod v3 refined and superRefined object schemas while keeping refined records wrapped', async () => {
    const refinedV3Object = z3
      .object({
        name: z3.string().describe('Person name'),
        age: z3.number().int().describe('Person age'),
      })
      .refine((val) => val.age >= 18, {
        message: 'Must be an adult',
        path: ['age'],
      });
    const superRefinedV3Object = refinedV3Object.superRefine((val, ctx) => {
      if (val.name.trim().length === 0) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: 'Name cannot be blank',
          path: ['name'],
        });
      }
    });

    const tool = new SetModelResponseTool(superRefinedV3Object);
    const decl = tool._getDeclaration();
    expect(decl.parameters?.type).toBe(Type.OBJECT);
    expect(decl.parameters?.properties?.['response']).toBeUndefined();
    expect(decl.parameters?.properties?.['name']?.description).toBe(
      'Person name',
    );
    expect(decl.parameters?.required).toEqual(['name', 'age']);

    const validContext = await createTestToolContext();
    expect(
      await tool.runAsync({
        args: {name: 'Alice', age: 21},
        toolContext: validContext,
      }),
    ).toEqual({name: 'Alice', age: 21});
    expect(validContext.actions.setModelResponse).toEqual({
      name: 'Alice',
      age: 21,
    });

    const invalidContext = await createTestToolContext();
    const invalidResult = (await tool.runAsync({
      args: {name: '   ', age: 15},
      toolContext: invalidContext,
    })) as {error: string};
    expect(invalidResult.error).toContain('Validation Error found:');
    expect(invalidResult.error).toContain('Must be an adult');
    expect(invalidResult.error).toContain('Name cannot be blank');
    expect(invalidContext.actions.setModelResponse).toBeUndefined();

    const refinedV3Record = z3
      .record(z3.string(), z3.number())
      .refine((rec) => Object.keys(rec).length > 0, {
        message: 'Record cannot be empty',
      });
    const recordTool = new SetModelResponseTool(refinedV3Record);
    expect(recordTool._getDeclaration().parameters?.required).toEqual([
      'response',
    ]);
    const recordCtx = await createTestToolContext();
    expect(
      await recordTool.runAsync({
        args: {response: {score: 10}},
        toolContext: recordCtx,
      }),
    ).toEqual({score: 10});
  });

  it('preserves Date instances, required nullable fields, and nullable record entries while omitting optional nulls', async () => {
    const nullableFieldSchema = z.object({
      answer: z.string(),
      reason: z.string().nullable(),
      optionalNote: z.string().nullable().optional(),
      nested: z.object({
        detail: z.string().nullable(),
        hint: z.string().nullable().optional(),
      }),
      metadata: z.record(z.string(), z.string().nullable()),
    });
    const nullableTool = new SetModelResponseTool(nullableFieldSchema);
    const nullableContext = await createTestToolContext();

    const nullableResult = await nullableTool.runAsync({
      args: {
        answer: 'ok',
        reason: null,
        optionalNote: null,
        nested: {detail: null, hint: null},
        metadata: {first: 'value', empty: null},
      },
      toolContext: nullableContext,
    });

    expect(nullableResult).toEqual({
      answer: 'ok',
      reason: null,
      nested: {detail: null},
      metadata: {first: 'value', empty: null},
    });
    expect(nullableResult).not.toHaveProperty('optionalNote');
    expect(
      (nullableResult as {nested: Record<string, unknown>}).nested,
    ).not.toHaveProperty('hint');
    expect(nullableContext.actions.setModelResponse).toEqual(nullableResult);

    const validatingAgent = new LlmAgent({
      name: 'nullableValidatorAgent',
      outputSchema: nullableFieldSchema,
    });
    expect(validatingAgent.validateOutput(nullableResult)).toEqual(
      nullableResult,
    );

    const topLevelRecordTool = new SetModelResponseTool(
      z.record(z.string(), z.string().nullable()),
    );
    const topRecordCtx = await createTestToolContext();
    expect(
      await topLevelRecordTool.runAsync({
        args: {response: {present: 'yes', missing: null}},
        toolContext: topRecordCtx,
      }),
    ).toEqual({present: 'yes', missing: null});

    const dateTransformV3Tool = new SetModelResponseTool(
      z3.object({
        createdAt: z3.coerce.date(),
        label: z3.string(),
      }),
    );
    const dateV3Ctx = await createTestToolContext();
    const dateV3Result = (await dateTransformV3Tool.runAsync({
      args: {createdAt: '2026-01-02T03:04:05.000Z', label: 'release'},
      toolContext: dateV3Ctx,
    })) as {createdAt: unknown; label: string};
    expect(dateV3Result.createdAt).toBeInstanceOf(Date);
    expect((dateV3Result.createdAt as Date).toISOString()).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    expect(dateV3Result.label).toBe('release');

    const dateTransformV4Tool = new SetModelResponseTool(
      z.object({
        createdAt: z.string().transform((iso) => new Date(iso)),
      }),
    );
    const dateV4Ctx = await createTestToolContext();
    const dateV4Result = (await dateTransformV4Tool.runAsync({
      args: {createdAt: '2026-02-03T04:05:06.000Z'},
      toolContext: dateV4Ctx,
    })) as {createdAt: unknown};
    expect(dateV4Result.createdAt).toBeInstanceOf(Date);
    expect((dateV4Result.createdAt as Date).toISOString()).toBe(
      '2026-02-03T04:05:06.000Z',
    );
  });
});
