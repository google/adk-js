/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {
  isZodObject,
  isZodSchema,
  zodObjectToSchema,
} from './simple_zod_to_json.js';

/**
 * Input/output schema type for agent.
 */
export type LlmAgentSchema =
  | z3.ZodObject<z3.ZodRawShape>
  | z4.ZodObject<z4.ZodRawShape>
  | Schema;

/**
 * Validates a value against a schema.
 * Throws an error if validation fails.
 */
export function validateSchema(
  value: unknown,
  schema: LlmAgentSchema,
  contextName: string,
): void {
  if (isZodSchema(schema)) {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `Validation failed for ${contextName}: ${result.error.message}`,
      );
    }
  } else {
    validateJsonSchema(value, schema, contextName);
  }
}

function fail(contextName: string, path: string, msg: string): never {
  throw new Error(`Validation failed for ${contextName}${path}: ${msg}`);
}

function validateJsonSchema(
  value: unknown,
  schema: Schema,
  contextName: string,
  path: string = '',
): void {
  if (Object.keys(schema).length === 0) {
    return;
  }

  const type = schema.type;
  if (!type) {
    if (schema.properties && (typeof value !== 'object' || value === null)) {
      fail(contextName, path, `expected object, got ${typeof value}`);
    }
    return;
  }

  const expectedType = type.toLowerCase();
  const actualType = typeof value;

  if (value === null) {
    if (schema.nullable) {
      return;
    }
    fail(contextName, path, 'value is null but schema is not nullable');
  }

  if (value === undefined) {
    fail(contextName, path, 'value is undefined');
  }

  const checkType = (expected: string) => {
    if (actualType !== expected) {
      fail(contextName, path, `expected ${expected}, got ${actualType}`);
    }
  };

  switch (expectedType) {
    case 'string':
      checkType('string');
      break;
    case 'number':
    case 'integer':
      checkType('number');
      if (expectedType === 'integer' && !Number.isInteger(value)) {
        fail(contextName, path, 'expected integer, got float');
      }
      break;
    case 'boolean':
      checkType('boolean');
      break;
    case 'array':
      if (!Array.isArray(value)) {
        fail(contextName, path, `expected array, got ${actualType}`);
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          validateJsonSchema(
            value[i],
            schema.items,
            contextName,
            `${path}[${i}]`,
          );
        }
      }
      break;
    case 'object': {
      if (actualType !== 'object' || value === null || Array.isArray(value)) {
        fail(contextName, path, `expected object, got ${actualType}`);
      }
      const obj = value as Record<string, unknown>;

      if (schema.required) {
        for (const reqKey of schema.required) {
          if (!(reqKey in obj) || obj[reqKey] === undefined) {
            fail(contextName, path, `missing required property "${reqKey}"`);
          }
        }
      }

      if (schema.properties) {
        for (const key in obj) {
          if (schema.properties[key]) {
            validateJsonSchema(
              obj[key],
              schema.properties[key],
              contextName,
              `${path}.${key}`,
            );
          }
        }
      }
      break;
    }
    case 'null':
      if (value !== null) {
        fail(contextName, path, `expected null, got ${actualType}`);
      }
      break;
  }
}

/**
 * Converts a LlmAgentSchema (Zod or GenAI Schema) to a GenAI Schema.
 */
export function toSchema(schema: LlmAgentSchema | undefined): Schema {
  if (schema === undefined) {
    return {type: Type.OBJECT, properties: {}};
  }

  if (isZodObject(schema)) {
    return zodObjectToSchema(schema);
  }

  return schema;
}
