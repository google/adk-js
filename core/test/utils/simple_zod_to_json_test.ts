/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zodObjectToSchema} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {
  getZodVoidOrUndefinedDescription,
  isZodVoidOrUndefined,
} from '../../src/utils/simple_zod_to_json.js';

describe('zodObjectToSchema', () => {
  describe.each([
    {name: 'z3', z: z3},
    {name: 'z4', z: z4},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ])('$name', ({z}: {z: any}) => {
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
              email: {
                type: Type.STRING,
                format: 'email',
              },
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
      const schema = z
        .object({
          name: z.string(),
        })
        .catchall(z.string());

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
          uuid: {
            type: Type.STRING,
            format: 'uuid',
          },
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
          integer: {
            type: Type.INTEGER,
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
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

    it('handles native enums', () => {
      enum NativeEnum {
        A = 'a',
        B = 'b',
      }
      const schema = z.object({
        nativeEnum: z.nativeEnum(NativeEnum),
      });

      const jsonSchema = zodObjectToSchema(schema);

      expect(jsonSchema).toEqual({
        type: Type.OBJECT,
        properties: {
          nativeEnum: {type: Type.STRING, enum: ['a', 'b']},
        },
        required: ['nativeEnum'],
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
          nullableString: {
            type: Type.STRING,
            nullable: true,
          },
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
          mustBeNull: {type: Type.NULL, nullable: true},
        },
        required: ['mustBeNull'],
      });
    });

    it('handles any and unknown types', () => {
      const schema = z.object({
        anyValue: z.any().optional(),
        unknownValue: z.unknown().optional(),
      });

      const jsonSchema = zodObjectToSchema(schema);

      expect(jsonSchema).toEqual({
        type: Type.OBJECT,
        properties: {
          anyValue: {},
          unknownValue: {},
        },
      });
    });

    it('handles branded types', () => {
      const schema = z.object({
        brandedString: (z.string() as z3.ZodString).brand<'MyBrand'>(),
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
      const schema = z3.string();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => zodObjectToSchema(schema as any)).toThrow(
        new Error('Expected a Zod Object'),
      );
    });

    it('inlines a sub-schema reused in two properties', () => {
      const inner = z.object({a: z.string()});
      const schema = z.object({first: inner, second: inner});

      const jsonSchema = zodObjectToSchema(schema);

      expect(jsonSchema).toEqual({
        type: Type.OBJECT,
        properties: {
          first: {
            type: Type.OBJECT,
            properties: {a: {type: Type.STRING}},
            required: ['a'],
          },
          second: {
            type: Type.OBJECT,
            properties: {a: {type: Type.STRING}},
            required: ['a'],
          },
        },
        required: ['first', 'second'],
      });
      expect(JSON.stringify(jsonSchema)).not.toContain('$ref');
      expect(JSON.stringify(jsonSchema)).not.toContain('definitions');
    });

    it('inlines a sub-schema reused as a property and as an array item', () => {
      const item = z.object({id: z.number().int()});
      const schema = z.object({one: item, many: z.array(item)});

      const jsonSchema = zodObjectToSchema(schema);

      const expectedItem = {
        type: Type.OBJECT,
        properties: {
          id: {
            type: Type.INTEGER,
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ['id'],
      };
      expect(jsonSchema).toEqual({
        type: Type.OBJECT,
        properties: {
          one: expectedItem,
          many: {type: Type.ARRAY, items: expectedItem},
        },
        required: ['one', 'many'],
      });
      expect(JSON.stringify(jsonSchema)).not.toContain('$ref');
    });
  });

  describe('z3 recursive schemas', () => {
    it('degrades the recursive field rather than hanging', () => {
      interface Tree {
        name: string;
        child?: Tree;
      }
      const tree: z3.ZodType<Tree> = z3.lazy(() =>
        z3.object({name: z3.string(), child: tree.optional()}),
      );

      const jsonSchema = zodObjectToSchema(
        z3.object({root: tree, plain: z3.string()}),
      );

      expect(jsonSchema).toEqual({
        type: Type.OBJECT,
        properties: {
          root: {
            type: Type.OBJECT,
            properties: {name: {type: Type.STRING}, child: {}},
            required: ['name'],
          },
          plain: {type: Type.STRING},
        },
        required: ['root', 'plain'],
      });
      expect(JSON.stringify(jsonSchema)).not.toContain('$ref');
    });
  });
});

describe('isZodVoidOrUndefined', () => {
  describe.each([
    {
      version: 'Zod 3',
      voidSchema: z3.void(),
      undefinedSchema: z3.undefined(),
      optionalVoidSchema: z3.void().optional(),
      nullableVoidSchema: z3.void().nullable(),
      optionalUndefinedSchema: z3.undefined().optional(),
      nullableUndefinedSchema: z3.undefined().nullable(),
      nullSchema: z3.null(),
      anySchema: z3.any(),
      unknownSchema: z3.unknown(),
      nullableStringSchema: z3.string().nullable(),
    },
    {
      version: 'Zod 4',
      voidSchema: z4.void(),
      undefinedSchema: z4.undefined(),
      optionalVoidSchema: z4.void().optional(),
      nullableVoidSchema: z4.void().nullable(),
      optionalUndefinedSchema: z4.undefined().optional(),
      nullableUndefinedSchema: z4.undefined().nullable(),
      nullSchema: z4.null(),
      anySchema: z4.any(),
      unknownSchema: z4.unknown(),
      nullableStringSchema: z4.string().nullable(),
    },
  ])('$version', (cases) => {
    it('returns true for void and undefined schemas including optional and nullable wrappers', () => {
      expect(isZodVoidOrUndefined(cases.voidSchema)).toBe(true);
      expect(isZodVoidOrUndefined(cases.undefinedSchema)).toBe(true);
      expect(isZodVoidOrUndefined(cases.optionalVoidSchema)).toBe(true);
      expect(isZodVoidOrUndefined(cases.nullableVoidSchema)).toBe(true);
      expect(isZodVoidOrUndefined(cases.optionalUndefinedSchema)).toBe(true);
      expect(isZodVoidOrUndefined(cases.nullableUndefinedSchema)).toBe(true);
    });

    it('returns false for null, any, unknown, typed nullable, and non-Zod values', () => {
      expect(isZodVoidOrUndefined(cases.nullSchema)).toBe(false);
      expect(isZodVoidOrUndefined(cases.anySchema)).toBe(false);
      expect(isZodVoidOrUndefined(cases.unknownSchema)).toBe(false);
      expect(isZodVoidOrUndefined(cases.nullableStringSchema)).toBe(false);
      expect(isZodVoidOrUndefined(null)).toBe(false);
      expect(isZodVoidOrUndefined(undefined)).toBe(false);
      expect(isZodVoidOrUndefined({type: Type.NULL})).toBe(false);
    });
  });
});

describe('getZodVoidOrUndefinedDescription', () => {
  describe.each([
    {
      version: 'Zod 3',
      describedVoid: z3.void().describe('Void output'),
      describedUndefined: z3.undefined().describe('Undefined output'),
      innerDescribedOptionalVoid: z3.void().describe('Inner void').optional(),
      outerDescribedOptionalVoid: z3.void().optional().describe('Outer void'),
      innerDescribedNullableUndefined: z3
        .undefined()
        .describe('Inner undefined')
        .nullable(),
      outerDescribedNullableUndefined: z3
        .undefined()
        .nullable()
        .describe('Outer undefined'),
      bothDescribedOptionalVoid: z3
        .void()
        .describe('Inner')
        .optional()
        .describe('Outer'),
      emptyDescribedVoid: z3.void().describe(''),
      undescribedVoid: z3.void(),
      describedNull: z3.null().describe('Null output'),
      describedOptionalString: z3.string().describe('String output').optional(),
    },
    {
      version: 'Zod 4',
      describedVoid: z4.void().describe('Void output'),
      describedUndefined: z4.undefined().describe('Undefined output'),
      innerDescribedOptionalVoid: z4.void().describe('Inner void').optional(),
      outerDescribedOptionalVoid: z4.void().optional().describe('Outer void'),
      innerDescribedNullableUndefined: z4
        .undefined()
        .describe('Inner undefined')
        .nullable(),
      outerDescribedNullableUndefined: z4
        .undefined()
        .nullable()
        .describe('Outer undefined'),
      bothDescribedOptionalVoid: z4
        .void()
        .describe('Inner')
        .optional()
        .describe('Outer'),
      emptyDescribedVoid: z4.void().describe(''),
      undescribedVoid: z4.void(),
      describedNull: z4.null().describe('Null output'),
      describedOptionalString: z4.string().describe('String output').optional(),
    },
  ])('$version', (cases) => {
    it('extracts the first non-empty description across void, undefined, and optional or nullable wrappers', () => {
      expect(getZodVoidOrUndefinedDescription(cases.describedVoid)).toBe(
        'Void output',
      );
      expect(getZodVoidOrUndefinedDescription(cases.describedUndefined)).toBe(
        'Undefined output',
      );
      expect(
        getZodVoidOrUndefinedDescription(cases.innerDescribedOptionalVoid),
      ).toBe('Inner void');
      expect(
        getZodVoidOrUndefinedDescription(cases.outerDescribedOptionalVoid),
      ).toBe('Outer void');
      expect(
        getZodVoidOrUndefinedDescription(cases.innerDescribedNullableUndefined),
      ).toBe('Inner undefined');
      expect(
        getZodVoidOrUndefinedDescription(cases.outerDescribedNullableUndefined),
      ).toBe('Outer undefined');
      expect(
        getZodVoidOrUndefinedDescription(cases.bothDescribedOptionalVoid),
      ).toBe('Outer');
    });

    it('returns undefined when no non-empty description is present or schema is not void or undefined', () => {
      expect(
        getZodVoidOrUndefinedDescription(cases.emptyDescribedVoid),
      ).toBeUndefined();
      expect(
        getZodVoidOrUndefinedDescription(cases.undescribedVoid),
      ).toBeUndefined();
      expect(
        getZodVoidOrUndefinedDescription(cases.describedNull),
      ).toBeUndefined();
      expect(
        getZodVoidOrUndefinedDescription(cases.describedOptionalString),
      ).toBeUndefined();
      expect(getZodVoidOrUndefinedDescription(null)).toBeUndefined();
      expect(getZodVoidOrUndefinedDescription(undefined)).toBeUndefined();
    });
  });
});
