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

  describe('format retention', () => {
    // reference: test_sanitize_integer_formats
    it('preserves int32 and int64 formats for integer types and drops invalid formats', () => {
      const input = {
        type: 'object',
        properties: {
          int32Field: {type: 'integer', format: 'int32'},
          int64Field: {type: 'integer', format: 'int64'},
          invalidIntFormat: {type: 'integer', format: 'unsigned'},
        },
      };

      const schema = toGeminiSchema(input as unknown as MCPToolSchema);

      expect(schema?.properties?.['int32Field']?.format).toBe('int32');
      expect(schema?.properties?.['int64Field']?.format).toBe('int64');
      expect(schema?.properties?.['invalidIntFormat']?.format).toBeUndefined();
    });

    // reference: test_sanitize_string_formats
    it('preserves date-time and enum formats for string types and drops other formats', () => {
      const input = {
        type: 'object',
        properties: {
          datetimeField: {type: 'string', format: 'date-time'},
          enumField: {type: 'string', format: 'enum', enum: ['a', 'b']},
          dateField: {type: 'string', format: 'date'},
          emailField: {type: 'string', format: 'email'},
          byteField: {type: 'string', format: 'byte'},
        },
      };

      const schema = toGeminiSchema(input as unknown as MCPToolSchema);

      expect(schema?.properties?.['datetimeField']?.format).toBe('date-time');
      expect(schema?.properties?.['enumField']?.format).toBe('enum');
      expect(schema?.properties?.['dateField']?.format).toBeUndefined();
      expect(schema?.properties?.['emailField']?.format).toBeUndefined();
      expect(schema?.properties?.['byteField']?.format).toBeUndefined();
    });

    // reference: test_sanitize_number_formats
    it('preserves int32 format for number types and drops float and double', () => {
      const input = {
        type: 'object',
        properties: {
          floatField: {type: 'number', format: 'float'},
          doubleField: {type: 'number', format: 'double'},
          int32Number: {type: 'number', format: 'int32'},
        },
      };

      const schema = toGeminiSchema(input as unknown as MCPToolSchema);

      expect(schema?.properties?.['floatField']?.format).toBeUndefined();
      expect(schema?.properties?.['doubleField']?.format).toBeUndefined();
      expect(schema?.properties?.['int32Number']?.format).toBe('int32');
    });

    // reference: test_preserve_valid_formats_without_type
    it('drops format when the declared type is missing or an array', () => {
      const withoutType = {
        format: 'date-time',
        properties: {
          field1: {format: 'int32'},
        },
      };
      const schemaWithoutType = toGeminiSchema(
        withoutType as unknown as MCPToolSchema,
      );
      expect(schemaWithoutType?.format).toBeUndefined();
      expect(schemaWithoutType?.properties?.['field1']?.format).toBeUndefined();

      const withArrayType = {
        type: ['string', 'null'],
        format: 'date-time',
      };
      const schemaWithArray = toGeminiSchema(
        withArrayType as unknown as MCPToolSchema,
      );
      expect(schemaWithArray?.format).toBeUndefined();
    });

    // reference: test_sanitize_nested_formats
    it('sanitizes format in nested properties and array items', () => {
      const input = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              dateStr: {type: 'string', format: 'date'},
              intField: {type: 'integer', format: 'int64'},
            },
          },
          arrayField: {
            type: 'array',
            items: {type: 'string', format: 'uri'},
          },
        },
      };

      const schema = toGeminiSchema(input as unknown as MCPToolSchema);

      expect(
        schema?.properties?.['nested']?.properties?.['dateStr']?.format,
      ).toBeUndefined();
      expect(
        schema?.properties?.['nested']?.properties?.['intField']?.format,
      ).toBe('int64');
      expect(schema?.properties?.['arrayField']?.items?.format).toBeUndefined();
    });

    // reference: test_sanitize_anyof_formats
    it('sanitizes format in anyOf branches', () => {
      const input = {
        anyOf: [
          {type: 'string', format: 'email'},
          {type: 'integer', format: 'int32'},
          {type: 'string', format: 'date-time'},
        ],
      };

      const schema = toGeminiSchema(input as unknown as MCPToolSchema);

      expect(schema?.anyOf?.[0]?.format).toBeUndefined();
      expect(schema?.anyOf?.[1]?.format).toBe('int32');
      expect(schema?.anyOf?.[2]?.format).toBe('date-time');
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

  describe('format retention', () => {
    // reference: test_sanitize_integer_formats
    it('preserves int32 and int64 for integer schemas and drops invalid formats', () => {
      const schema = openApiSchemaToGeminiSchema({
        type: 'object',
        properties: {
          int32Field: {type: 'integer', format: 'int32'},
          int64Field: {type: 'integer', format: 'int64'},
          invalidInt: {type: 'integer', format: 'unsigned'},
        },
      });

      expect(schema?.properties?.['int32Field']?.format).toBe('int32');
      expect(schema?.properties?.['int64Field']?.format).toBe('int64');
      expect(schema?.properties?.['invalidInt']?.format).toBeUndefined();
    });

    // reference: test_sanitize_string_formats
    it('preserves date-time and enum for string schemas and drops other formats', () => {
      const schema = openApiSchemaToGeminiSchema({
        type: 'object',
        properties: {
          datetimeField: {type: 'string', format: 'date-time'},
          enumField: {type: 'string', format: 'enum'},
          dateField: {type: 'string', format: 'date'},
          emailField: {type: 'string', format: 'email'},
          byteField: {type: 'string', format: 'byte'},
        },
      });

      expect(schema?.properties?.['datetimeField']?.format).toBe('date-time');
      expect(schema?.properties?.['enumField']?.format).toBe('enum');
      expect(schema?.properties?.['dateField']?.format).toBeUndefined();
      expect(schema?.properties?.['emailField']?.format).toBeUndefined();
      expect(schema?.properties?.['byteField']?.format).toBeUndefined();
    });

    // reference: test_sanitize_number_formats
    it('preserves int32 and int64 for number schemas and drops float and double', () => {
      const schema = openApiSchemaToGeminiSchema({
        type: 'object',
        properties: {
          floatField: {type: 'number', format: 'float'},
          doubleField: {type: 'number', format: 'double'},
          int32Number: {type: 'number', format: 'int32'},
          int64Number: {type: 'number', format: 'int64'},
        },
      });

      expect(schema?.properties?.['floatField']?.format).toBeUndefined();
      expect(schema?.properties?.['doubleField']?.format).toBeUndefined();
      expect(schema?.properties?.['int32Number']?.format).toBe('int32');
      expect(schema?.properties?.['int64Number']?.format).toBe('int64');
    });

    // reference: test_preserve_valid_formats_without_type
    it('drops format on schemas without an explicit single primitive type', () => {
      const untyped = openApiSchemaToGeminiSchema({
        format: 'date-time',
        properties: {
          field1: {format: 'int32'},
        },
      });
      expect(untyped?.format).toBeUndefined();
      expect(untyped?.properties?.['field1']?.format).toBeUndefined();

      const arrayType = openApiSchemaToGeminiSchema({
        type: ['string', 'null'],
        format: 'date-time',
      });
      expect(arrayType?.format).toBeUndefined();
    });

    // reference: test_to_gemini_schema_remove_unrecognized_fields
    it('preserves valid formats and drops unsupported keys through public converter', () => {
      const schema = openApiSchemaToGeminiSchema({
        type: 'string',
        description: 'A date-time string.',
        format: 'date-time',
        title: 'Ignored Title',
        default: '2026-01-01T00:00:00Z',
      });

      expect(schema).toEqual({
        type: Type.STRING,
        description: 'A date-time string.',
        format: 'date-time',
      });
      expect(schema?.['title']).toBeUndefined();
      expect(schema?.['default']).toBeUndefined();
    });

    // reference: test_sanitize_nested_formats
    it('sanitizes format in nested properties and items', () => {
      const schema = openApiSchemaToGeminiSchema({
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              dateStr: {type: 'string', format: 'date'},
              intField: {type: 'integer', format: 'int64'},
            },
          },
          arrayField: {
            type: 'array',
            items: {type: 'string', format: 'uri'},
          },
        },
      });

      expect(
        schema?.properties?.['nested']?.properties?.['dateStr']?.format,
      ).toBeUndefined();
      expect(
        schema?.properties?.['nested']?.properties?.['intField']?.format,
      ).toBe('int64');
      expect(schema?.properties?.['arrayField']?.items?.format).toBeUndefined();
    });

    // reference: test_sanitize_anyof_formats
    it('sanitizes format in anyOf branches', () => {
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
  });
});
