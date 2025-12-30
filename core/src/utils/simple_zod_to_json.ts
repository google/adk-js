/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {
  JsonSchema7ArrayType,
  JsonSchema7BigintType,
  JsonSchema7EnumType,
  JsonSchema7NumberType,
  JsonSchema7ObjectType,
  JsonSchema7StringType,
  zodToJsonSchema as toJSONSchemaV3,
} from 'zod-to-json-schema';
import {z as z3} from 'zod/v3';
import {toJSONSchema as toJSONSchemaV4, z as z4} from 'zod/v4';

type ZodSchema<T = unknown> = z3.ZodType<T> | z4.ZodType<T>;

function isZodSchema(obj: unknown): obj is ZodSchema {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'parse' in obj &&
    typeof (obj as {parse: unknown}).parse === 'function' &&
    'safeParse' in obj &&
    typeof (obj as {safeParse: unknown}).safeParse === 'function'
  );
}

function isZodV3Schema(obj: unknown): obj is z3.ZodTypeAny {
  return isZodSchema(obj) && !('_zod' in obj);
}

function isZodV4Schema(obj: unknown): obj is z4.ZodType {
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
      override: (ctx) => {
        const {jsonSchema} = ctx;

        if (jsonSchema.additionalProperties !== undefined) {
          delete jsonSchema.additionalProperties;
        }

        if (jsonSchema.readOnly !== undefined) {
          delete jsonSchema.readOnly;
        }

        if (jsonSchema.maxItems !== undefined) {
          (jsonSchema as Schema).maxItems = jsonSchema.maxItems.toString();
        }

        if (jsonSchema.format === 'email' || jsonSchema.format === 'uuid') {
          delete jsonSchema.pattern;
        }

        if (jsonSchema.minItems !== undefined) {
          (jsonSchema as Schema).minItems = jsonSchema.minItems.toString();
        }

        if (jsonSchema.minLength !== undefined) {
          (jsonSchema as Schema).minLength = jsonSchema.minLength.toString();
        }

        if (jsonSchema.maxLength !== undefined) {
          (jsonSchema as Schema).maxLength = jsonSchema.maxLength.toString();
        }

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

        if ((jsonSchema as JsonSchema7ArrayType).maxItems !== undefined) {
          (jsonSchema as Schema).maxItems = (
            jsonSchema as JsonSchema7ArrayType
          ).maxItems?.toString();
        }

        if ((jsonSchema as JsonSchema7ArrayType).minItems !== undefined) {
          (jsonSchema as Schema).minItems = (
            jsonSchema as JsonSchema7ArrayType
          ).minItems?.toString();
        }

        if ((jsonSchema as JsonSchema7StringType).minLength !== undefined) {
          (jsonSchema as Schema).minLength = (
            jsonSchema as JsonSchema7StringType
          ).minLength?.toString();
        }

        if ((jsonSchema as JsonSchema7StringType).maxLength !== undefined) {
          (jsonSchema as Schema).maxLength = (
            jsonSchema as JsonSchema7StringType
          ).maxLength?.toString();
        }

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
