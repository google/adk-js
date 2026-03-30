/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toGeminiSchema} from '../../src/utils/gemini_schema_util.js';

interface MCPToolSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

describe('toGeminiSchema', () => {
  it('converts a simple object schema with explicit type', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'number'},
      },
      required: ['name'],
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.NUMBER},
      },
      required: ['name'],
    });
  });

  it('infers OBJECT type from properties when type is missing', () => {
    const input = {
      properties: {
        name: {type: 'string'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
      },
    });
  });

  it('infers ARRAY type from items when type is missing', () => {
    const input = {
      items: {type: 'string'},
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.STRING},
    });
  });

  it('handles optional types (anyOf with null) by picking the non-null type', () => {
    const input = {
      anyOf: [{type: 'string'}, {type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // Should resolve to STRING
    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('handles optional types (anyOf with null) reverse order', () => {
    const input = {
      anyOf: [{type: 'null'}, {type: 'string'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('handles anyOf with null only', () => {
    const input = {
      anyOf: [{type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
    });
  });

  it('handles nested complex schemas with missing types', () => {
    const input = {
      // Missing top-level type, inferred as OBJECT
      properties: {
        tags: {
          // Missing array type, inferred as ARRAY
          items: {type: 'string'},
        },
        metadata: {
          // Optional object via anyOf
          anyOf: [
            {
              properties: {created: {type: 'string'}},
            },
            {type: 'null'},
          ],
        },
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: {type: Type.STRING},
        },
        metadata: {
          type: Type.OBJECT,
          properties: {
            created: {type: Type.STRING},
          },
          nullable: true,
        },
      },
    });
  });

  it('handles $ref by defaulting to OBJECT', () => {
    const input = {
      $ref: '#/definitions/MyType',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('handles array-typed type field with null – picks non-null type', () => {
    const input = {
      type: ['string', 'null'],
      description: 'an optional string',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      description: 'an optional string',
      nullable: true,
    });
  });

  it('handles array-typed type field without null – picks the single non-null type', () => {
    const input = {
      type: ['integer'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.INTEGER,
      description: undefined,
    });
  });

  it('handles array-typed type field with case-insensitive NULL', () => {
    const input = {
      type: ['boolean', 'NULL'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.BOOLEAN,
      description: undefined,
      nullable: true,
    });
  });

  it('handles array-typed type field with reverse order', () => {
    const input = {
      type: ['null', 'boolean'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.BOOLEAN,
      description: undefined,
      nullable: true,
    });
  });

  it('handles array-typed type field with only null', () => {
    const input = {
      type: ['null'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
      description: undefined,
    });
  });

  it('handles type null', () => {
    const input = {
      type: 'null',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
      description: undefined,
    });
  });

  it('handles empty items schema for arrays (e.g., items: {}) without crashing', () => {
    const input = {
      type: 'array',
      items: {}, // valid JSON Schema meaning "any", seen in AWS MCP server
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // For empty items schema, items type becomes TYPE_UNSPECIFIED
    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.TYPE_UNSPECIFIED},
    });
  });

  it('handles TYPE_UNSPECIFIED when without type and without anyOf', () => {
    const input = {
      description: 'only description',
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.TYPE_UNSPECIFIED,
      description: 'only description',
    });
  });

  it('handles type array with multiple non-null types via anyOf', () => {
    const input = {
      type: ['string', 'integer', 'null'],
      description: 'multi-type field',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      description: 'multi-type field',
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}, {type: Type.NULL}],
    });
  });

  it('handles type array with multiple non-null types in reverse order via anyOf', () => {
    const input = {
      type: ['null', 'integer', 'string'],
      description: 'multi-type field',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      description: 'multi-type field',
      anyOf: [{type: Type.NULL}, {type: Type.INTEGER}, {type: Type.STRING}],
    });
  });

  it('handles type array with multiple non-null types without null', () => {
    const input = {
      type: ['string', 'integer'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
    });
  });

  it('handles anyOf with multiple non-null types and null', () => {
    const input = {
      anyOf: [{type: 'string'}, {type: 'integer'}, {type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}, {type: Type.NULL}],
    });
  });

  it('handles anyOf with multiple non-null object types', () => {
    const input = {
      anyOf: [
        {type: 'object', properties: {a: {type: 'string'}}},
        {type: 'string'},
      ],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [
        {type: Type.OBJECT, properties: {a: {type: Type.STRING}}},
        {type: Type.STRING},
      ],
    });
  });
});
