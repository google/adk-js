/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

/**
 * Keys of a genai `Schema` that carry a count/length bound. The genai (OpenAPI)
 * encoding sends these as strings; JSON Schema requires numbers.
 */
const NUMERIC_STRING_KEYS = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
] as const;

/**
 * Keys that exist only in the genai/OpenAPI dialect and have no JSON Schema
 * meaning, so they are dropped rather than passed through to a validator.
 */
const NON_JSON_SCHEMA_KEYS = new Set(['propertyOrdering', 'example']);

/** JSON Schema type names, keyed by the genai `Type` enum value. */
const TYPE_NAMES: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null',
};

/**
 * Converts a genai `Schema` into a standard JSON Schema object.
 *
 * This is the inverse of `zodObjectToSchema`, which renders Zod into the
 * genai/OpenAPI dialect. The two dialects differ in four ways, all handled
 * here:
 *
 * - `type` is an uppercase enum (`STRING`) rather than a JSON Schema type name
 *   (`string`). `TYPE_UNSPECIFIED` means "no constraint" and is dropped.
 * - `nullable: true` widens the type, which JSON Schema expresses as a type
 *   union (`['string', 'null']`).
 * - Count and length bounds are stringified (`maxItems: '5'`).
 * - `propertyOrdering` and `example` have no JSON Schema equivalent.
 *
 * Everything else (`description`, `title`, `default`, `pattern`, `required`,
 * `minimum`, `maximum`, `format`) is already JSON-Schema-shaped and passes
 * through, with `items`, `properties` and `anyOf` converted recursively.
 */
export function genaiSchemaToJsonSchema(
  schema: Schema,
): Record<string, unknown> {
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || NON_JSON_SCHEMA_KEYS.has(key)) {
      continue;
    }

    switch (key) {
      case 'type':
      case 'nullable':
        // Handled together below, since `nullable` widens `type`.
        break;
      case 'items':
        out['items'] = genaiSchemaToJsonSchema(value as Schema);
        break;
      case 'properties': {
        const properties: Record<string, unknown> = {};
        for (const [name, property] of Object.entries(
          value as Record<string, Schema>,
        )) {
          properties[name] = genaiSchemaToJsonSchema(property);
        }
        out['properties'] = properties;
        break;
      }
      case 'anyOf':
        out['anyOf'] = (value as Schema[]).map(genaiSchemaToJsonSchema);
        break;
      case 'format':
        // `enum` is a genai marker for "this string field is an enumeration",
        // not a JSON Schema format; the `enum` member list already says so.
        if (value !== 'enum') {
          out['format'] = value;
        }
        break;
      default:
        out[key] = NUMERIC_STRING_KEYS.includes(
          key as (typeof NUMERIC_STRING_KEYS)[number],
        )
          ? Number(value)
          : value;
    }
  }

  const typeName =
    typeof schema.type === 'string' ? TYPE_NAMES[schema.type] : undefined;
  if (typeName) {
    out['type'] = schema.nullable ? [typeName, 'null'] : typeName;
  }

  // genai sends every enum member as a string, even for a numeric field
  // (`{type: INTEGER, format: enum, enum: ['101', '201']}`), so the members
  // have to be narrowed back to match the declared type.
  if (
    Array.isArray(out['enum']) &&
    (typeName === 'integer' || typeName === 'number')
  ) {
    out['enum'] = (out['enum'] as unknown[]).map((member) =>
      typeof member === 'string' &&
      member.trim() !== '' &&
      !isNaN(Number(member))
        ? Number(member)
        : member,
    );
  }

  return out;
}
