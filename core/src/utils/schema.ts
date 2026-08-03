/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single, reusable abstraction over the schema formats ADK APIs accept: a Zod
 * v3 type, a Zod v4 type, or a genai `Schema`. Mirrors the union
 * `FunctionTool` uses for its parameters, but at the `ZodType` level (any
 * schema, not just an object) so it also fits value validation.
 */

import {Schema} from '@google/genai';
import {zodToJsonSchema as toJSONSchemaV3} from 'zod-to-json-schema';
import {z as z3} from 'zod/v3';
import {toJSONSchema as toJSONSchemaV4, z as z4} from 'zod/v4';

import {
  isZodSchema,
  isZodV3Schema,
  isZodV4Schema,
} from './simple_zod_to_json.js';

/**
 * A schema accepted by ADK APIs, expressed as a Zod v3 type, a Zod v4 type, or
 * a genai `Schema`.
 *
 * Use {@link parseWithSchema} to validate a value against one, and
 * {@link toJsonSchema} to render one as a plain JSON Schema.
 */
export type SchemaLike = z3.ZodType | z4.ZodType | Schema;

/**
 * Validates `value` against `schema`.
 *
 * - Zod v3/v4 schema: runs `schema.parse(value)` and returns the parsed value.
 * - genai `Schema` or `undefined`: returns `value` unchanged. A genai `Schema`
 *   is a declaration, not a runtime validator, so it is not enforced here —
 *   matching how `FunctionTool` only `.parse()`s Zod parameters.
 */
export function parseWithSchema<T>(
  schema: SchemaLike | undefined,
  value: T,
): T {
  if (schema !== undefined && isZodSchema(schema)) {
    return schema.parse(value) as T;
  }
  return value;
}

/**
 * Renders a {@link SchemaLike} as a plain JSON Schema object.
 *
 * Zod v3 and v4 schemas are converted with their respective serializers; a
 * genai `Schema` is already schema-shaped and is returned as-is.
 */
export function toJsonSchema(schema: SchemaLike): Record<string, unknown> {
  if (isZodV4Schema(schema)) {
    return toJSONSchemaV4(schema) as Record<string, unknown>;
  }
  if (isZodV3Schema(schema)) {
    return toJSONSchemaV3(schema) as Record<string, unknown>;
  }
  return schema as Record<string, unknown>;
}
