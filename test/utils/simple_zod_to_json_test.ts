/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {z} from 'zod';

import {zodObjectToSchema} from '../../src/utils/simple_zod_to_json.js';

describe('zodObjectToSchema', () => {
  it('converts a simple Zod object to JSON schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.NUMBER},
      },
      required: ['name', 'age'],
    });
  });

  it('handles optional properties', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.NUMBER},
      },
      required: ['name'],
    });
  });

  it('handles nested objects', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
        email: z.string().email(),
      }),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        user: {
          type: Type.OBJECT,
          properties: {
            name: {type: Type.STRING},
            email: {type: Type.STRING, format: 'email'},
          },
          required: ['name', 'email'],
        },
      },
      required: ['user'],
    });
  });

  it('handles arrays', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: {type: Type.STRING},
        },
      },
      required: ['tags'],
    });
  });

  it('handles additional properties', () => {
    const schema = z.object({
                      name: z.string(),
                    }).catchall(z.string());

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
      },
      required: ['name'],
    });
  });

  it('handles string constraints', () => {
    const schema = z.object({
      description: z.string().min(10).max(1000),
      url: z.string().url(),
      uuid: z.string().uuid(),
      regex: z.string().regex(/^[a-z]+$/),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        description: {type: Type.STRING, minLength: '10', maxLength: '1000'},
        url: {type: Type.STRING, format: 'uri'},
        uuid: {type: Type.STRING, format: 'uuid'},
        regex: {type: Type.STRING, pattern: '^[a-z]+$'},
      },
      required: ['description', 'url', 'uuid', 'regex'],
    });
  });

  it('handles number constraints', () => {
    const schema = z.object({
      integer: z.number().int(),
      numberRange: z.number().min(0).max(100),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        integer: {type: Type.INTEGER},
        numberRange: {type: Type.NUMBER, minimum: 0, maximum: 100},
      },
      required: ['integer', 'numberRange'],
    });
  });

  it('handles booleans', () => {
    const schema = z.object({
      isReady: z.boolean(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        isReady: {type: Type.BOOLEAN},
      },
      required: ['isReady'],
    });
  });

  it('handles enums', () => {
    const schema = z.object({
      status: z.enum(['pending', 'completed']),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        status: {type: Type.STRING, enum: ['pending', 'completed']},
      },
      required: ['status'],
    });
  });

  it('handles literals', () => {
    const schema = z.object({
      version: z.literal('1.0'),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        version: {type: Type.STRING, enum: ['1.0']},
      },
      required: ['version'],
    });
  });

  it('handles nullable types', () => {
    const schema = z.object({
      nullableString: z.string().nullable(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        nullableString: {anyOf: [{type: Type.STRING}, {type: Type.NULL}]},
      },
      required: ['nullableString'],
    });
  });

  it('handles default values', () => {
    const schema = z.object({
      defaultValue: z.string().default('default'),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        defaultValue: {type: Type.STRING, default: 'default'},
      },
      required: [],
    });
  });

  it('handles array constraints', () => {
    const schema = z.object({
      stringArray: z.array(z.string()).min(1).max(10),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        stringArray: {
          type: Type.ARRAY,
          items: {type: Type.STRING},
          minItems: '1',
          maxItems: '10',
        },
      },
      required: ['stringArray'],
    });
  });

  it('handles null types', () => {
    const schema = z.object({
      mustBeNull: z.null(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        mustBeNull: {type: Type.NULL},
      },
      required: ['mustBeNull'],
    });
  });

  it('handles any and unknown types', () => {
    const schema = z.object({
      anyValue: z.any(),
      unknownValue: z.unknown(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        anyValue: {},
        unknownValue: {},
      },
      required: ['anyValue', 'unknownValue'],
    });
  });

  it('handles branded types', () => {
    const schema = z.object({
      brandedString: z.string().brand<'MyBrand'>(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        brandedString: {type: Type.STRING},
      },
      required: ['brandedString'],
    });
  });

  it('handles readonly types', () => {
    const schema = z.object({
      readonlyString: z.string().readonly(),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        readonlyString: {type: Type.STRING},
      },
      required: ['readonlyString'],
    });
  });

  it('handles union types', () => {
    const schema = z.object({
      union: z.union([z.string(), z.number()]),
    });

    const jsonSchema = zodObjectToSchema(schema);

    expect(jsonSchema).toEqual({
      type: Type.OBJECT,
      properties: {
        union: {anyOf: [{type: Type.STRING}, {type: Type.NUMBER}]},
      },
      required: ['union'],
    });
  });

  it('throws an error for non-object schemas', () => {
    const schema = z.string();
    expect(() => zodObjectToSchema(schema as any))
        .toThrow(new Error('Expected a ZodObject'));
  });
});