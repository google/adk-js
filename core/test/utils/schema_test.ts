/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {parseWithSchema, toJsonSchema} from '../../src/utils/schema.js';

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

  it('does not validate a genai Schema (returns the value unchanged)', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {count: {type: Type.NUMBER}},
    };
    const value = {anything: 'goes'};
    // A genai Schema is a declaration, not a runtime validator.
    expect(parseWithSchema(schema, value)).toBe(value);
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

  it('returns a genai Schema as-is', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {count: {type: Type.NUMBER}},
    };
    expect(toJsonSchema(schema)).toBe(schema);
  });
});
