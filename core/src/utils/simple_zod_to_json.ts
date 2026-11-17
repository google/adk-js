/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {
  JsonSchema7BigintType,
  JsonSchema7EnumType,
  JsonSchema7NumberType,
  JsonSchema7ObjectType,
  zodToJsonSchema as toJSONSchemaV3,
} from 'zod-to-json-schema';
import {z as z3} from 'zod/v3';
import {toJSONSchema as toJSONSchemaV4, z as z4} from 'zod/v4';

import {copySchemaConstraints} from './gemini_schema_util.js';

export type ZodSchema<T = unknown> = z3.ZodType<T> | z4.ZodType<T>;

/** Returns true if the value is a Zod schema (v3 or v4). */
export function isZodSchema(obj: unknown): obj is ZodSchema {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'parse' in obj &&
    typeof (obj as {parse: unknown}).parse === 'function' &&
    'safeParse' in obj &&
    typeof (obj as {safeParse: unknown}).safeParse === 'function'
  );
}

/** Returns true if the value is a Zod v3 schema. */
export function isZodV3Schema(obj: unknown): obj is z3.ZodTypeAny {
  return isZodSchema(obj) && !('_zod' in obj);
}

/** Returns true if the value is a Zod v4 schema. */
export function isZodV4Schema(obj: unknown): obj is z4.ZodType {
  return isZodSchema(obj) && '_zod' in obj;
}

function getZodTypeName(
  schema: z3.ZodTypeAny | z4.ZodType,
): string | undefined {
  const schemaAny = schema as {_def: z3.ZodTypeDef | z4.ZodType};

  if ((schemaAny._def as z3.ZodStringDef)?.typeName) {
    return (schemaAny._def as z3.ZodStringDef).typeName;
  }

  const zod4Type = (schemaAny._def as z4.ZodType)?.type;
  if (typeof zod4Type === 'string' && zod4Type) {
    return 'Zod' + zod4Type.charAt(0).toUpperCase() + zod4Type.slice(1);
  }

  return undefined;
}

/**
 * Returns true if the given object is a ZodObject (supports both Zod v3 and v4).
 */
export function isZodObject(
  obj: unknown,
): obj is z3.ZodObject<z3.ZodRawShape> | z4.ZodObject<z4.ZodRawShape> {
  return isZodSchema(obj) && getZodTypeName(obj) === 'ZodObject';
}

/**
 * Returns true if the given object is a ZodVoid (supports both Zod v3 and v4).
 */
export function isZodVoid(obj: unknown): obj is z3.ZodVoid | z4.ZodVoid {
  return isZodSchema(obj) && getZodTypeName(obj) === 'ZodVoid';
}

function unwrapOptionalOrNullable(schema: ZodSchema): ZodSchema {
  let current: ZodSchema = schema;
  while (
    getZodTypeName(current) === 'ZodOptional' ||
    getZodTypeName(current) === 'ZodNullable'
  ) {
    const inner = (current as {_def?: {innerType?: unknown}})._def?.innerType;
    if (!isZodSchema(inner)) {
      break;
    }
    current = inner;
  }
  return current;
}

/**
 * Returns true if `obj` is a Zod `void` or `undefined` schema, including when
 * wrapped in `.optional()` or `.nullable()` (supports both Zod v3 and v4).
 */
export function isZodVoidOrUndefined(obj: unknown): obj is ZodSchema {
  if (!isZodSchema(obj)) {
    return false;
  }
  const typeName = getZodTypeName(unwrapOptionalOrNullable(obj));
  return typeName === 'ZodVoid' || typeName === 'ZodUndefined';
}

/**
 * Returns the outermost non-empty description on a Zod schema, falling back
 * through `.optional()` / `.nullable()` wrappers (Zod v4 keeps inner
 * `.describe()` metadata on `innerType` rather than the outer wrapper).
 */
export function getZodDescription(schema: ZodSchema): string | undefined {
  let current: unknown = schema;
  while (isZodSchema(current)) {
    if (
      typeof current.description === 'string' &&
      current.description.length > 0
    ) {
      return current.description;
    }
    const typeName = getZodTypeName(current);
    if (typeName !== 'ZodOptional' && typeName !== 'ZodNullable') {
      break;
    }
    current = (current as {_def?: {innerType?: unknown}})._def?.innerType;
  }
  return undefined;
}

export function zodObjectToSchema(
  schema: z3.ZodObject<z3.ZodRawShape> | z4.ZodObject<z4.ZodRawShape>,
): Schema {
  if (!isZodObject(schema)) {
    throw new Error('Expected a Zod Object');
  }

  if (isZodV4Schema(schema)) {
    return toJSONSchemaV4(schema, {
      target: 'openapi-3.0',
      io: 'input',
      unrepresentable: 'any',
      override: (ctx) => {
        const {jsonSchema} = ctx;

        if (jsonSchema.additionalProperties !== undefined) {
          delete jsonSchema.additionalProperties;
        }

        if (jsonSchema.readOnly !== undefined) {
          delete jsonSchema.readOnly;
        }

        // Counts, lengths, patterns and numeric bounds are carried by the same
        // rules `toGeminiSchema` applies, so a Zod object and a serialized Zod
        // response declare the same constraints for the same Zod schema.
        copySchemaConstraints(
          jsonSchema as unknown as Record<string, unknown>,
          jsonSchema as unknown as Record<string, unknown>,
        );

        if (jsonSchema.enum?.length === 1 && jsonSchema.enum[0] === null) {
          (jsonSchema as Schema).type = Type.NULL;
          delete jsonSchema.enum;
        }

        if (jsonSchema.type !== undefined) {
          (jsonSchema as {type: string}).type = (
            jsonSchema as {type: string}
          ).type.toUpperCase();
        }
      },
    }) as Schema;
  }

  if (isZodV3Schema(schema)) {
    return toJSONSchemaV3(schema, {
      target: 'openApi3',
      // The genai `Schema` type has no `$ref`, so a pointer back at an earlier
      // occurrence of a reused sub-schema reaches the model as an untyped
      // parameter. Inline every occurrence instead. A cycle has no finite
      // inlining and degrades to an unconstrained schema.
      $refStrategy: 'none',
      emailStrategy: 'format:email',
      postProcess: (jsonSchema) => {
        if (!jsonSchema) {
          return;
        }

        if (
          (jsonSchema as JsonSchema7ObjectType).additionalProperties !==
          undefined
        ) {
          delete (jsonSchema as JsonSchema7ObjectType).additionalProperties;
        }

        // `zod-to-json-schema` represents `z3.undefined()` as `{not: {}}`,
        // which `@google/genai` `Schema` rejects; degrade it to `{}` like v4.
        if ('not' in jsonSchema) {
          delete (jsonSchema as Record<string, unknown>)['not'];
        }

        // Counts, lengths, patterns and numeric bounds are carried by the same
        // rules `toGeminiSchema` applies, so a Zod object and a serialized Zod
        // response declare the same constraints for the same Zod schema.
        copySchemaConstraints(
          jsonSchema as unknown as Record<string, unknown>,
          jsonSchema as unknown as Record<string, unknown>,
        );

        if (
          (jsonSchema as JsonSchema7EnumType).enum?.length === 1 &&
          (jsonSchema as JsonSchema7EnumType).enum[0] === 'null'
        ) {
          (jsonSchema as Schema).type = Type.NULL;
          delete (jsonSchema as unknown as {enum?: []}).enum;
        }

        if (
          (jsonSchema as JsonSchema7NumberType).type === 'integer' &&
          (jsonSchema as JsonSchema7BigintType).format !== 'int64'
        ) {
          (jsonSchema as JsonSchema7NumberType).minimum ??=
            Number.MIN_SAFE_INTEGER;
          (jsonSchema as JsonSchema7NumberType).maximum ??=
            Number.MAX_SAFE_INTEGER;
        }

        if ((jsonSchema as {type: string}).type !== undefined) {
          (jsonSchema as {type: string}).type = (
            jsonSchema as {type: string}
          ).type.toUpperCase();
        }

        return jsonSchema;
      },
    }) as Schema;
  }

  throw new Error('Unsupported Zod schema version.');
}
