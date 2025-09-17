/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z, ZodObject, ZodTypeAny} from 'zod';

/**
 * Returns true if the given object is a V3 ZodObject.
 */
export function isZodObject(obj: unknown): obj is ZodObject<any> {
  return (
      obj !== null && typeof obj === 'object' &&
      (obj as any)._def?.typeName === 'ZodObject');
}

// TODO(b/425992518): consider conversion to FunctionDeclaration directly.

function parseZodType(zodType: ZodTypeAny): Schema|undefined {
  const def = zodType._def;
  if (!def) {
    return {};
  }
  const description = def.description;
  const result: Schema = {};
  if (description) result.description = description;

  const returnResult = (result: Schema) => {
    if (result.description === undefined) {
      delete result.description;
    }
    return result;
  };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      result.type = Type.STRING;
      for (const check of def.checks || []) {
        if (check.kind === 'min')
          result.minLength = check.value.toString();
        else if (check.kind === 'max')
          result.maxLength = check.value.toString();
        else if (check.kind === 'email')
          result.format = 'email';
        else if (check.kind === 'uuid')
          result.format = 'uuid';
        else if (check.kind === 'url')
          result.format = 'uri';
        else if (check.kind === 'regex')
          result.pattern = check.regex.source;
      }
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodNumber:
      result.type = Type.NUMBER;
      for (const check of def.checks || []) {
        if (check.kind === 'min')
          result.minimum = check.value;
        else if (check.kind === 'max')
          result.maximum = check.value;
        else if (check.kind === 'int')
          result.type = Type.INTEGER;
      }
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      result.type = Type.BOOLEAN;
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodArray:
      result.type = Type.ARRAY;
      result.items = parseZodType(def.type);
      if (def.minLength) result.minItems = def.minLength.value.toString();
      if (def.maxLength) result.maxItems = def.maxLength.value.toString();
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodObject: {
      const nestedSchema = zodObjectToSchema(zodType as ZodObject<any>);
      return nestedSchema as Schema;
    }

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      const literalType = typeof def.value;
      result.enum = [def.value.toString()];

      if (literalType === 'string') {
        result.type = Type.STRING;
      } else if (literalType === 'number') {
        result.type = Type.NUMBER;
      } else if (literalType === 'boolean') {
        result.type = Type.BOOLEAN;
      } else if (def.value === null) {
        result.type = Type.NULL;
      } else {
        throw new Error(`Unsupported ZodLiteral value type: ${literalType}`);
      }

      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodEnum:
      result.type = Type.STRING;
      result.enum = def.values;
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      result.type = Type.STRING;
      result.enum = Object.values(def.values);
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodUnion:
      result.anyOf = def.options.map(parseZodType);
      return returnResult(result);

    case z.ZodFirstPartyTypeKind.ZodOptional:
      return parseZodType(def.innerType);
    case z.ZodFirstPartyTypeKind.ZodNullable:
      const nullableInner = parseZodType(def.innerType);
      return nullableInner ?
          returnResult({
            anyOf: [nullableInner, {type: Type.NULL}],
            ...(description && {description})
          }) :
          returnResult({type: Type.NULL, ...(description && {description})});
    case z.ZodFirstPartyTypeKind.ZodDefault:
      const defaultInner = parseZodType(def.innerType);
      if (defaultInner) defaultInner.default = def.defaultValue();
      return defaultInner;
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return parseZodType(def.type);
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      return parseZodType(def.innerType);
    case z.ZodFirstPartyTypeKind.ZodNull:
      result.type = Type.NULL;
      return returnResult(result);
    case z.ZodFirstPartyTypeKind.ZodAny:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return returnResult({...(description && {description})});
    default:
      throw new Error(`Unsupported Zod type: ${def.typeName}`);
  }
}

export function zodObjectToSchema(schema: ZodObject<any>): Schema {
  if (schema._def.typeName !== z.ZodFirstPartyTypeKind.ZodObject) {
    throw new Error('Expected a ZodObject');
  }

  const shape = schema.shape;
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  for (const key in shape) {
    const fieldSchema = shape[key];
    const parsedField = parseZodType(fieldSchema);
    if (parsedField) {
      properties[key] = parsedField;
    }

    let currentSchema = fieldSchema;
    let isOptional = false;
    while (currentSchema._def.typeName ===
               z.ZodFirstPartyTypeKind.ZodOptional ||
           currentSchema._def.typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
        isOptional = true;
      currentSchema = currentSchema._def.innerType;
    }
    if (!isOptional) {
      required.push(key);
    }
  }

  const catchall = schema._def.catchall;
  let additionalProperties: boolean|Schema = false;
  if (catchall && catchall._def.typeName !== z.ZodFirstPartyTypeKind.ZodNever) {
    additionalProperties = parseZodType(catchall) || true;
  } else {
    additionalProperties = schema._def.unknownKeys === 'passthrough';
  }
  return {
    type: Type.OBJECT,
    properties,
    required: required.length > 0 ? required : [],
    ...(schema._def.description ? {description: schema._def.description} : {}),
  };
}
