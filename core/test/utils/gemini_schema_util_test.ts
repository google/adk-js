/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  openApiSchemaToGeminiSchema,
  toGeminiSchema,
} from '../../src/utils/gemini_schema_util.js';

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

  it('handles enum-only schema (no type field) without crashing', () => {
    const input = {
      enum: ['red', 'green', 'blue'],
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['red', 'green', 'blue'],
    });
  });

  it('handles enum-only schema with description', () => {
    const input = {
      description: 'A color value',
      enum: ['red', 'green', 'blue'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      description: 'A color value',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('handles enum-only schema with mixed types (no type inferred)', () => {
    const input = {
      enum: ['red', 1, true],
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.TYPE_UNSPECIFIED,
      enum: ['red', '1', 'true'],
    });
  });

  it('handles enum with explicit type field', () => {
    const input = {
      type: 'string' as const,
      enum: ['asc', 'desc'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['asc', 'desc'],
    });
  });

  it('drops a null member from a string-typed enum', () => {
    const input = {
      type: 'string' as const,
      enum: ['a', null],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['a'],
    });
  });

  it('drops a null member from a nullable string enum', () => {
    const input = {
      type: ['string', 'null'],
      enum: ['a', null],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
      enum: ['a'],
    });
  });

  it('drops a null enum member on a nested property', () => {
    const input = {
      type: 'object' as const,
      properties: {
        status: {type: 'string', enum: ['open', null]},
      },
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        status: {type: Type.STRING, enum: ['open']},
      },
    });
  });

  it('yields an empty enum when every string enum member is null', () => {
    const input = {
      type: 'string' as const,
      enum: [null],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: [],
    });
  });

  it('keeps stringified members on a non-string enum', () => {
    const input = {
      type: 'integer' as const,
      enum: [1, 2],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.INTEGER,
      enum: ['1', '2'],
    });
  });

  it('drops a null member from an integer-typed enum', () => {
    const input = {
      type: 'integer' as const,
      enum: [1, null],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.INTEGER,
      enum: ['1'],
    });
  });

  it('drops a null member from an enum with no declared type', () => {
    const input = {
      enum: ['a', null],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.TYPE_UNSPECIFIED,
      enum: ['a'],
    });
  });

  it('handles const-only schema with string value', () => {
    const input = {
      const: 'fixed-value',
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // const is not a Gemini Schema field; type is inferred from the const value
    // and the value is forwarded as a single-element enum
    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['fixed-value'],
    });
  });

  it('handles const-only schema with numeric value', () => {
    const input = {
      const: 42,
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NUMBER,
      enum: ['42'],
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

  it('converts a boolean true branch inside anyOf to an object schema', () => {
    const input = {anyOf: [true]} as unknown as MCPToolSchema;

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({type: Type.OBJECT, properties: {}});
  });

  it('converts a boolean false branch inside anyOf to an object schema', () => {
    const input = {anyOf: [false]} as unknown as MCPToolSchema;

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({type: Type.OBJECT, properties: {}});
  });

  it('keeps an anyOf with a boolean branch nullable', () => {
    const input = {anyOf: [true, {type: 'null'}]} as unknown as MCPToolSchema;

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      nullable: true,
      properties: {},
    });
  });

  it('converts a boolean branch alongside a typed branch', () => {
    const input = {anyOf: [true, {type: 'string'}]} as unknown as MCPToolSchema;

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      anyOf: [{type: Type.OBJECT, properties: {}}, {type: Type.STRING}],
    });
  });

  it('converts every boolean branch of an all-boolean anyOf', () => {
    const input = {anyOf: [true, false]} as unknown as MCPToolSchema;

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      anyOf: [
        {type: Type.OBJECT, properties: {}},
        {type: Type.OBJECT, properties: {}},
      ],
    });
  });

  it('converts a boolean member of a type array', () => {
    const input = {type: [true]} as unknown as MCPToolSchema;

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({type: Type.OBJECT, properties: {}});
  });

  it('converts a boolean member alongside a named type', () => {
    const input = {type: [true, 'string']} as unknown as MCPToolSchema;

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      anyOf: [{type: Type.OBJECT, properties: {}}, {type: Type.STRING}],
    });
  });

  it('converts a boolean branch on a nested property', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {a: {anyOf: [true]}},
    };

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {a: {type: Type.OBJECT, properties: {}}},
    });
  });

  it('converts a boolean branch inside array items', () => {
    const input = {
      type: 'array',
      items: {anyOf: [true]},
    } as unknown as MCPToolSchema;

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.OBJECT, properties: {}},
    });
  });

  it('converts a boolean true property schema to an object schema', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {
        model: true,
      },
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        model: {type: Type.OBJECT, properties: {}},
      },
    });
  });

  it('converts a boolean false property schema to an object schema without throwing', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {
        anything: false,
      },
    };

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        anything: {type: Type.OBJECT, properties: {}},
      },
    });
  });

  it('converts a boolean true schema nested in array item properties', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {
        title: {type: 'string'},
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              datasourceUid: {type: 'string'},
              model: true,
              queryType: {type: 'string'},
              refId: {type: 'string'},
            },
          },
        },
      },
      required: ['title', 'data'],
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        title: {type: Type.STRING},
        data: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              datasourceUid: {type: Type.STRING},
              model: {type: Type.OBJECT, properties: {}},
              queryType: {type: Type.STRING},
              refId: {type: Type.STRING},
            },
          },
        },
      },
      required: ['title', 'data'],
    });
  });

  it('converts a boolean array items schema to an object schema', () => {
    const input = {
      type: 'array',
      items: true,
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.OBJECT, properties: {}},
    });
  });

  it('converts a boolean false array items schema to an object schema', () => {
    const input = {
      type: 'array',
      items: false,
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.OBJECT, properties: {}},
    });
  });

  it('converts a boolean schema in an anyOf branch to an object schema', () => {
    const input = {
      anyOf: [true, {type: 'string'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [{type: Type.OBJECT, properties: {}}, {type: Type.STRING}],
    });
  });
});

describe('toGeminiSchema constraint preservation', () => {
  it('keeps array bounds on the root and on nested arrays', () => {
    const schema = toGeminiSchema({
      type: 'array',
      maxItems: 4,
      items: {type: 'array', minItems: 2, items: {type: 'string'}},
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      maxItems: '4',
      items: {
        type: Type.ARRAY,
        minItems: '2',
        items: {type: Type.STRING},
      },
    });
  });

  it('keeps array bounds through a nullable anyOf branch', () => {
    const schema = toGeminiSchema({
      anyOf: [
        {type: 'array', minItems: 2, maxItems: 3, items: {type: 'string'}},
        {type: 'null'},
      ],
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      nullable: true,
      minItems: '2',
      maxItems: '3',
      items: {type: Type.STRING},
    });
  });

  it('keeps array bounds through a nullable type array', () => {
    const schema = toGeminiSchema({
      type: ['array', 'null'],
      minItems: 2,
      items: {type: 'string'},
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      nullable: true,
      minItems: '2',
      items: {type: Type.STRING},
    });
  });

  it('keeps the bounds of every anyOf branch', () => {
    const schema = toGeminiSchema({
      anyOf: [
        {type: 'array', minItems: 2, items: {type: 'string'}},
        {type: 'number', minimum: 1},
      ],
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [
        {type: Type.ARRAY, minItems: '2', items: {type: Type.STRING}},
        {type: Type.NUMBER, minimum: 1},
      ],
    });
  });

  it('keeps string length bounds and pattern', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        name: {type: 'string', minLength: 3, maxLength: 5, pattern: '^[a-z]+$'},
      },
      required: ['name'],
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          minLength: '3',
          maxLength: '5',
          pattern: '^[a-z]+$',
        },
      },
      required: ['name'],
    });
  });

  it('keeps numeric range bounds as numbers', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {age: {type: 'number', minimum: 1, maximum: 9}},
      required: ['age'],
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {age: {type: Type.NUMBER, minimum: 1, maximum: 9}},
      required: ['age'],
    });
  });

  it('keeps object property-count bounds as string counts', () => {
    const schema = toGeminiSchema({
      type: 'object',
      minProperties: 1,
      maxProperties: 3,
      properties: {name: {type: 'string'}},
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {name: {type: Type.STRING}},
      minProperties: '1',
      maxProperties: '3',
    });
  });

  it('normalizes string counts already in the genai dialect', () => {
    const schema = toGeminiSchema({
      type: 'array',
      minItems: '2',
      items: {type: 'string'},
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      minItems: '2',
      items: {type: Type.STRING},
    });
  });

  it('leaves an unbounded schema without constraint fields', () => {
    const schema = toGeminiSchema({
      type: 'array',
      items: {type: 'string'},
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.STRING},
    });
  });

  it('drops the generated pattern that only restates an email format', () => {
    const schema = toGeminiSchema({
      type: 'string',
      format: 'email',
      pattern: '^[^@]+@[^@]+$',
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({type: Type.STRING});
  });

  it('retains supported formats and drops unsupported formats in toGeminiSchema', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        int32Field: {type: 'integer', format: 'int32'},
        int64Field: {type: 'integer', format: 'int64'},
        unsignedInt: {type: 'integer', format: 'unsigned'},
        numInt32: {type: 'number', format: 'int32'},
        numInt64: {type: 'number', format: 'int64'},
        numFloat: {type: 'number', format: 'float'},
        numDouble: {type: 'number', format: 'double'},
        dateTimeStr: {type: 'string', format: 'date-time'},
        enumStr: {type: 'string', format: 'enum', enum: ['a', 'b']},
        dateStr: {type: 'string', format: 'date'},
        emailStr: {type: 'string', format: 'email'},
        nullableWithFormat: {type: ['string', 'null'], format: 'date-time'},
        untypedWithFormat: {format: 'date-time'},
        anyOfWithFormat: {
          anyOf: [{type: 'string', format: 'date-time'}, {type: 'null'}],
        },
      },
    } as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        int32Field: {type: Type.INTEGER, format: 'int32'},
        int64Field: {type: Type.INTEGER, format: 'int64'},
        unsignedInt: {type: Type.INTEGER},
        numInt32: {type: Type.NUMBER, format: 'int32'},
        numInt64: {type: Type.NUMBER, format: 'int64'},
        numFloat: {type: Type.NUMBER},
        numDouble: {type: Type.NUMBER},
        dateTimeStr: {type: Type.STRING, format: 'date-time'},
        enumStr: {type: Type.STRING, format: 'enum', enum: ['a', 'b']},
        dateStr: {type: Type.STRING},
        emailStr: {type: Type.STRING},
        nullableWithFormat: {
          type: Type.STRING,
          format: 'date-time',
          nullable: true,
        },
        anyOfWithFormat: {
          type: Type.STRING,
          format: 'date-time',
          nullable: true,
        },
        untypedWithFormat: {type: Type.TYPE_UNSPECIFIED},
      },
    });
  });
});

describe('openApiSchemaToGeminiSchema', () => {
  it('normalizes a nullable type array into the non-null type with nullable set', () => {
    const schema = openApiSchemaToGeminiSchema({type: ['string', 'null']});

    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('leaves the type unspecified when the schema declares an unrecognized type', () => {
    const schema = openApiSchemaToGeminiSchema({type: 'custom'});

    expect(schema?.type).toBe(Type.TYPE_UNSPECIFIED);
  });

  it('preserves int32 and int64 formats and drops unsupported formats on integer types', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        int32_field: {type: 'integer', format: 'int32'},
        int64_field: {type: 'integer', format: 'int64'},
        invalid_int_format: {type: 'integer', format: 'unsigned'},
      },
    });

    expect(schema?.properties?.['int32_field']?.format).toBe('int32');
    expect(schema?.properties?.['int64_field']?.format).toBe('int64');
    expect(schema?.properties?.['invalid_int_format']?.format).toBeUndefined();
  });

  it('preserves date-time and enum formats and drops unsupported formats on string types', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        datetime_field: {type: 'string', format: 'date-time'},
        enum_field: {
          type: 'string',
          format: 'enum',
          enum: ['a', 'b'],
        },
        date_field: {type: 'string', format: 'date'},
        email_field: {type: 'string', format: 'email'},
        byte_field: {type: 'string', format: 'byte'},
      },
    });

    expect(schema?.properties?.['datetime_field']?.format).toBe('date-time');
    expect(schema?.properties?.['enum_field']?.format).toBe('enum');
    expect(schema?.properties?.['date_field']?.format).toBeUndefined();
    expect(schema?.properties?.['email_field']?.format).toBeUndefined();
    expect(schema?.properties?.['byte_field']?.format).toBeUndefined();
  });

  it('preserves int32 and int64 formats and drops float and double on number types', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        float_field: {type: 'number', format: 'float'},
        double_field: {type: 'number', format: 'double'},
        int32_number: {type: 'number', format: 'int32'},
        int64_number: {type: 'number', format: 'int64'},
      },
    });

    expect(schema?.properties?.['float_field']?.format).toBeUndefined();
    expect(schema?.properties?.['double_field']?.format).toBeUndefined();
    expect(schema?.properties?.['int32_number']?.format).toBe('int32');
    expect(schema?.properties?.['int64_number']?.format).toBe('int64');
  });

  it('sanitizes formats inside nested object properties and array items', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            date_str: {type: 'string', format: 'date'},
            int_field: {type: 'integer', format: 'int64'},
          },
        },
        array_field: {
          type: 'array',
          items: {type: 'string', format: 'uri'},
        },
      },
    });

    expect(
      schema?.properties?.['nested']?.properties?.['date_str']?.format,
    ).toBeUndefined();
    expect(
      schema?.properties?.['nested']?.properties?.['int_field']?.format,
    ).toBe('int64');
    expect(schema?.properties?.['array_field']?.items?.format).toBeUndefined();
  });

  it('sanitizes formats inside anyOf branches', () => {
    const schema = openApiSchemaToGeminiSchema({
      anyOf: [
        {type: 'string', format: 'email'},
        {type: 'integer', format: 'int32'},
        {type: 'string', format: 'date-time'},
      ],
    });

    expect(schema?.anyOf?.[0]?.format).toBeUndefined();
    expect(schema?.anyOf?.[1]?.format).toBe('int32');
    expect(schema?.anyOf?.[2]?.format).toBe('date-time');
  });

  it('preserves constraint fields and property names when converting OpenAPI schemas', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      minProperties: 1,
      maxProperties: 10,
      properties: {
        firstName: {type: 'string', minLength: 1, maxLength: 50},
        lastName: {type: 'string', minLength: 1, maxLength: 50},
      },
    });

    expect(schema?.minProperties).toBe(1);
    expect(schema?.maxProperties).toBe(10);
    expect(schema?.properties?.['firstName']?.minLength).toBe(1);
    expect(schema?.properties?.['firstName']?.maxLength).toBe(50);
  });

  it('drops format on untyped schemas and keeps it on nullable type arrays', () => {
    const schema = openApiSchemaToGeminiSchema({
      format: 'date-time',
      properties: {
        field1: {format: 'int32'},
        nullableDateTime: {type: ['string', 'null'], format: 'date-time'},
        nullableUuid: {type: ['string', 'null'], format: 'uuid'},
      },
    });

    expect(schema?.format).toBeUndefined();
    expect(schema?.properties?.['field1']?.format).toBeUndefined();
    expect(schema?.properties?.['nullableDateTime']).toEqual({
      type: Type.STRING,
      format: 'date-time',
      nullable: true,
    });
    expect(schema?.properties?.['nullableUuid']?.format).toBeUndefined();
  });

  it('filters unrecognized keys and unsupported formats across top-level and nested properties', () => {
    const schema = openApiSchemaToGeminiSchema({
      type: 'object',
      description: 'Test schema',
      properties: {
        valid_int: {type: 'integer', format: 'int32'},
        invalid_format_prop: {type: 'integer', format: 'unsigned'},
        valid_string: {type: 'string', format: 'date-time'},
        camelCaseKey: {type: 'string'},
        prop_with_extra_key: {
          type: 'boolean',
          unknownInternalKey: 'discard_this_value',
        },
      },
      required: ['valid_int'],
      additionalProperties: false,
      unknownTopLevelKey: 'discard_me_too',
    });

    expect(schema?.description).toBe('Test schema');
    expect(schema?.required).toEqual(['valid_int']);
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(schema).not.toHaveProperty('unknownTopLevelKey');
    expect(schema?.properties?.['valid_int']).toEqual({
      type: Type.INTEGER,
      format: 'int32',
    });
    expect(schema?.properties?.['invalid_format_prop']).toEqual({
      type: Type.INTEGER,
    });
    expect(schema?.properties?.['valid_string']).toEqual({
      type: Type.STRING,
      format: 'date-time',
    });
    expect(schema?.properties?.['camelCaseKey']).toEqual({
      type: Type.STRING,
    });
    expect(schema?.properties?.['prop_with_extra_key']).toEqual({
      type: Type.BOOLEAN,
    });
  });

  it('converts nullable anyOf branches and drops title and default fields', () => {
    const schema = openApiSchemaToGeminiSchema({
      properties: {
        case_id: {
          description: 'The ID of the case.',
          title: 'Case Id',
          type: 'string',
        },
        next_page_token: {
          anyOf: [{type: 'string'}, {type: 'null'}],
          default: null,
          description: 'The nextPageToken to fetch the next page of results.',
          title: 'Next Page Token',
        },
      },
      required: ['case_id'],
      title: 'list_alerts_by_caseArguments',
      type: 'object',
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      required: ['case_id'],
      properties: {
        case_id: {
          type: Type.STRING,
          description: 'The ID of the case.',
        },
        next_page_token: {
          type: Type.STRING,
          nullable: true,
          description: 'The nextPageToken to fetch the next page of results.',
        },
      },
    });
  });

  it('folds oneOf into anyOf and strips null branches into nullable', () => {
    const schema = openApiSchemaToGeminiSchema({
      description: 'An id or a name.',
      oneOf: [
        {type: 'integer', format: 'int64'},
        {type: 'string'},
        {type: 'null'},
      ],
    });

    expect(schema).toEqual({
      description: 'An id or a name.',
      nullable: true,
      anyOf: [{type: Type.INTEGER, format: 'int64'}, {type: Type.STRING}],
    });
  });

  it('merges anyOf and oneOf branches on the same schema', () => {
    const schema = openApiSchemaToGeminiSchema({
      anyOf: [{type: 'string'}],
      one_of: [{type: 'boolean'}],
    });

    expect(schema).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.BOOLEAN}],
    });
  });

  it('collapses a oneOf with a single non-null branch into that branch', () => {
    const schema = openApiSchemaToGeminiSchema({
      oneOf: [{type: 'string', format: 'date-time'}, {type: 'null'}],
    });

    expect(schema).toEqual({
      type: Type.STRING,
      format: 'date-time',
      nullable: true,
    });
  });

  it('converts a nested anyOf inside a collapsed single branch', () => {
    const schema = openApiSchemaToGeminiSchema({
      anyOf: [{anyOf: [{type: 'string'}, {type: 'integer'}]}, {type: 'null'}],
    });

    expect(schema).toEqual({
      nullable: true,
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
    });
  });

  it('converts a nested oneOf inside a collapsed single branch', () => {
    const schema = openApiSchemaToGeminiSchema({
      description: 'An optional name.',
      oneOf: [{oneOf: [{type: 'string'}, {type: 'null'}]}, {type: 'null'}],
    });

    expect(schema).toEqual({
      description: 'An optional name.',
      type: Type.STRING,
      nullable: true,
    });
  });

  it('treats a union of only null branches as a nullable object', () => {
    const schema = openApiSchemaToGeminiSchema({anyOf: [{type: 'null'}]});

    expect(schema).toEqual({type: Type.OBJECT, nullable: true});
  });

  it('throws a TypeError when the schema is not a plain object', () => {
    expect(() => openApiSchemaToGeminiSchema(['not', 'an', 'object'])).toThrow(
      new TypeError('openApiSchema must be a plain object'),
    );
  });
});
