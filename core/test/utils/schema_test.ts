/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {
  objectSchemaFields,
  parseWithSchema,
  toJsonSchema,
} from '../../src/utils/schema.js';
import {zodObjectToSchema} from '../../src/utils/simple_zod_to_json.js';

describe('parseWithSchema', () => {
  it('returns the value unchanged when no schema is given', () => {
    const value = {a: 1};
    expect(parseWithSchema(undefined, value)).toBe(value);
  });

  it('parses and returns the value for a valid Zod v4 schema', () => {
    const schema = z4.object({count: z4.number()});
    expect(parseWithSchema(schema, {count: 3})).toEqual({count: 3});
  });

  it('throws for a value that fails a Zod v4 schema', () => {
    const schema = z4.object({count: z4.number()});
    expect(() => parseWithSchema(schema, {count: 'no'})).toThrow();
  });

  it('parses and returns the value for a valid Zod v3 schema', () => {
    const schema = z3.object({count: z3.number()});
    expect(parseWithSchema(schema, {count: 7})).toEqual({count: 7});
  });

  it('throws for a value that fails a Zod v3 schema', () => {
    const schema = z3.object({count: z3.number()});
    expect(() => parseWithSchema(schema, {count: 'no'})).toThrow();
  });

  it('parses and returns the value for a valid genai Schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {count: {type: Type.NUMBER}},
      required: ['count'],
    };
    expect(parseWithSchema(schema, {count: 3})).toEqual({count: 3});
  });

  it('throws for a value that fails a genai Schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {count: {type: Type.NUMBER}},
      required: ['count'],
    };
    expect(() => parseWithSchema(schema, {count: 'no'})).toThrow();
    expect(() => parseWithSchema(schema, {})).toThrow();
  });

  it('enforces a genai Schema nested in an object and an array', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {id: {type: Type.INTEGER}},
            required: ['id'],
          },
        },
      },
      required: ['items'],
    };
    expect(parseWithSchema(schema, {items: [{id: 1}]})).toEqual({
      items: [{id: 1}],
    });
    expect(() => parseWithSchema(schema, {items: [{id: 'x'}]})).toThrow();
  });

  it('honours `nullable` on a genai Schema', () => {
    const schema: Schema = {type: Type.STRING, nullable: true};
    expect(parseWithSchema(schema, null)).toBeNull();
    expect(parseWithSchema(schema, 'text')).toBe('text');
    expect(() => parseWithSchema({type: Type.STRING}, null)).toThrow();
  });

  it('enforces genai bounds that are encoded as strings', () => {
    const schema: Schema = {
      type: Type.ARRAY,
      items: {type: Type.STRING},
      maxItems: '2',
    };
    expect(parseWithSchema(schema, ['a', 'b'])).toEqual(['a', 'b']);
    expect(() => parseWithSchema(schema, ['a', 'b', 'c'])).toThrow();
  });

  it('enforces a genai enum', () => {
    const schema: Schema = {
      type: Type.STRING,
      format: 'enum',
      enum: ['EAST', 'WEST'],
    };
    expect(parseWithSchema(schema, 'EAST')).toBe('EAST');
    expect(() => parseWithSchema(schema, 'NORTH')).toThrow();
  });

  it('leaves a genai Schema that has no Zod equivalent unenforced', () => {
    // `TYPE_UNSPECIFIED` carries no constraint, so nothing is rejected.
    const schema: Schema = {type: Type.TYPE_UNSPECIFIED};
    const value = {anything: 'goes'};
    expect(parseWithSchema(schema, value)).toEqual(value);
  });

  it('validates a round-tripped Zod schema the same way as the original', () => {
    const zod = z4.object({count: z4.number()});
    const roundTripped = zodObjectToSchema(zod);
    expect(parseWithSchema(roundTripped, {count: 3})).toEqual({count: 3});
    expect(() => parseWithSchema(roundTripped, {count: 'no'})).toThrow();
  });
});

describe('toJsonSchema', () => {
  it('converts a Zod v4 schema to a JSON schema', () => {
    const json = toJsonSchema(z4.object({count: z4.number()}));
    expect(json).toMatchObject({type: 'object'});
    expect((json.properties as Record<string, unknown>).count).toBeDefined();
  });

  it('converts a Zod v3 schema to a JSON schema', () => {
    const json = toJsonSchema(z3.object({count: z3.number()}));
    expect(json).toMatchObject({type: 'object'});
    expect((json.properties as Record<string, unknown>).count).toBeDefined();
  });

  it('translates a genai Schema out of the genai dialect', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        count: {type: Type.NUMBER},
        tags: {type: Type.ARRAY, items: {type: Type.STRING}, maxItems: '3'},
        note: {type: Type.STRING, nullable: true},
      },
      required: ['count'],
      propertyOrdering: ['count', 'tags'],
    };
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        count: {type: 'number'},
        tags: {type: 'array', items: {type: 'string'}, maxItems: 3},
        note: {type: ['string', 'null']},
      },
      required: ['count'],
    });
  });
});

describe('objectSchemaFields', () => {
  const fieldsOf = (schema: Parameters<typeof objectSchemaFields>[0]) =>
    objectSchemaFields(schema);

  it('decomposes a Zod v4 object into per-field validators', () => {
    const fields = fieldsOf(z4.object({count: z4.number(), name: z4.string()}));
    expect([...fields!.keys()]).toEqual(['count', 'name']);
    expect(fields!.get('count')!.safeParse(1).success).toBe(true);
    expect(fields!.get('count')!.safeParse('1').success).toBe(false);
  });

  it('decomposes a Zod v3 object into per-field validators', () => {
    const fields = fieldsOf(z3.object({count: z3.number(), name: z3.string()}));
    expect([...fields!.keys()]).toEqual(['count', 'name']);
    expect(fields!.get('count')!.safeParse(1).success).toBe(true);
    expect(fields!.get('count')!.safeParse('1').success).toBe(false);
  });

  it('decomposes a genai Schema into per-field validators', () => {
    const fields = fieldsOf({
      type: Type.OBJECT,
      properties: {count: {type: Type.NUMBER}, name: {type: Type.STRING}},
    } as Schema);
    expect([...fields!.keys()]).toEqual(['count', 'name']);
    expect(fields!.get('count')!.safeParse(1).success).toBe(true);
    expect(fields!.get('count')!.safeParse('1').success).toBe(false);
  });

  it('resolves a $ref to a reused sub-schema (Zod v3)', () => {
    // zod-to-json-schema points the second use of a shared sub-schema back at
    // the first as `{$ref: '#/properties/first'}`. Compiled detached from the
    // document, that field would silently lose its type check.
    const inner = z3.object({a: z3.string()});
    const fields = fieldsOf(z3.object({first: inner, second: inner}));
    const second = fields!.get('second');
    expect(second).toBeDefined();
    expect(second!.safeParse({a: 'ok'}).success).toBe(true);
    expect(second!.safeParse({a: 1}).success).toBe(false);
  });

  it('agrees across Zod v3 and Zod v4 for the same shape', () => {
    const v3 = fieldsOf(z3.object({n: z3.number(), s: z3.string().nullable()}));
    const v4 = fieldsOf(z4.object({n: z4.number(), s: z4.string().nullable()}));
    expect([...v3!.keys()]).toEqual([...v4!.keys()]);
    for (const key of v3!.keys()) {
      for (const value of [1, 'x', null, {}]) {
        expect(v3!.get(key)!.safeParse(value).success).toBe(
          v4!.get(key)!.safeParse(value).success,
        );
      }
    }
  });

  it('degrades only the recursive field of a cyclic schema', () => {
    interface Tree {
      name: string;
      child?: Tree;
    }
    const tree: z3.ZodType<Tree> = z3.lazy(() =>
      z3.object({name: z3.string(), child: tree.optional()}),
    );
    const fields = fieldsOf(z3.object({root: tree, plain: z3.string()}));
    // A cycle has no finite inlining, so that field goes unvalidated — but its
    // siblings keep their validators.
    expect(fields!.has('root')).toBe(true);
    expect(fields!.get('root')).toBeUndefined();
    expect(fields!.get('plain')!.safeParse('s').success).toBe(true);
  });

  it('returns undefined for a schema that is not an object', () => {
    expect(fieldsOf(z4.string())).toBeUndefined();
    expect(fieldsOf(z3.string())).toBeUndefined();
  });
});
