/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {toSnakeCaseName} from './case_utils.js';

type MCPToolSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};
type MCPTypeArrayItem = string | {type: string};

function toGeminiType(mcpType: string | undefined): Type {
  if (!mcpType) return Type.TYPE_UNSPECIFIED;

  switch (mcpType.toLowerCase()) {
    case 'text':
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'integer':
      return Type.INTEGER;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    case 'null':
      return Type.NULL;
    default:
      return Type.TYPE_UNSPECIFIED;
  }
}

const getTypeFromArrayItem = (
  mcpType: MCPTypeArrayItem,
): string | undefined => {
  if (typeof mcpType === 'string') {
    return mcpType.toLowerCase();
  }
  return mcpType?.type?.toLowerCase?.();
};

export function toGeminiSchema(mcpSchema?: MCPToolSchema): Schema | undefined {
  if (!mcpSchema) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recursiveConvert(mcp: any): Schema {
    const sourceType = mcp.anyOf ?? mcp.type;
    let isNullable = false;
    let nonNullTypes;
    if (Array.isArray(sourceType)) {
      nonNullTypes = sourceType.filter(
        (t: MCPTypeArrayItem) => getTypeFromArrayItem(t) !== 'null',
      );
      isNullable = sourceType.some(
        (t: MCPTypeArrayItem) => getTypeFromArrayItem(t) === 'null',
      );

      if (nonNullTypes.length === 1) {
        const nonNullType = nonNullTypes[0];
        if (typeof nonNullType === 'object') {
          mcp = nonNullType;
        } else {
          const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
          mcp = {...rest, type: nonNullType};
        }
      } else if (nonNullTypes.length === 0 && isNullable) {
        const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
        mcp = {...rest, type: 'null'};
      } else if (typeof mcp.anyOf === 'undefined') {
        const anyOfItems = mcp.type.map((t: MCPTypeArrayItem) => ({type: t}));
        const {type: _removed, ...rest} = mcp;
        mcp = {...rest, anyOf: anyOfItems};
      }
    }

    // Infer unknown types
    if (!mcp.type) {
      if (mcp.properties || mcp.$ref) {
        mcp.type = 'object';
      } else if (mcp.items) {
        mcp.type = 'array';
      } else if (isNullable) {
        mcp.type = 'null';
      } else if (mcp.enum) {
        // enum-only schema: infer type from enum values if all are the same
        // primitive type, otherwise leave type undefined (TYPE_UNSPECIFIED)
        const enumTypes = new Set((mcp.enum as unknown[]).map((v) => typeof v));
        if (enumTypes.size === 1) {
          const jsType = [...enumTypes][0];
          if (jsType === 'string') mcp.type = 'string';
          else if (jsType === 'number') mcp.type = 'number';
          else if (jsType === 'boolean') mcp.type = 'boolean';
        }
      } else if (mcp.const !== undefined) {
        // const-only schema: infer type from the const value and forward as
        // a single-element enum so the constraint is preserved in Gemini schema
        const jsType = typeof mcp.const;
        let inferredType: string | undefined;
        if (jsType === 'string') inferredType = 'string';
        else if (jsType === 'number') inferredType = 'number';
        else if (jsType === 'boolean') inferredType = 'boolean';
        mcp = {...mcp, type: inferredType, enum: [mcp.const]};
      }
    }

    const geminiType = toGeminiType(mcp.type);
    const geminiSchema: Schema = {};

    if (mcp.anyOf) {
      geminiSchema.anyOf = mcp.anyOf.map((item: Record<string, unknown>) =>
        recursiveConvert(item),
      );
    } else {
      geminiSchema.type = geminiType;
    }

    if (mcp.description) {
      geminiSchema.description = mcp.description;
    }

    if (mcp.enum) {
      // A null member carries nullability, not a value. Every member is
      // stringified below, so keeping it would offer the model 'null'.
      geminiSchema.enum = (mcp.enum as unknown[])
        .filter((v) => v != null)
        .map(String);
    }

    if (isNullable && mcp.type !== 'null') {
      geminiSchema.nullable = true;
    }

    if (geminiType === Type.OBJECT) {
      geminiSchema.properties = {};
      if (mcp.properties) {
        for (const name in mcp.properties) {
          geminiSchema.properties[name] = recursiveConvert(
            mcp.properties[name],
          );
        }
      }
      if (mcp.required) {
        geminiSchema.required = mcp.required;
      }
    } else if (geminiType === Type.ARRAY) {
      if (mcp.items) {
        geminiSchema.items = recursiveConvert(mcp.items);
      }
    }
    return geminiSchema;
  }
  return recursiveConvert(mcpSchema);
}

/**
 * Field names of the `Schema` interface exported by `@google/genai`. A key of
 * an OpenAPI schema that does not name one of these is dropped, because the
 * Gemini backend rejects a schema carrying a field it does not know.
 */
const GEMINI_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  'anyOf',
  'default',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'propertyOrdering',
  'required',
  'title',
  'type',
]);

/**
 * Fields the Gemini backend rejects even though `Schema` declares them. A
 * `format` of `date` on a STRING, for example, fails with "only 'enum' and
 * 'date-time' are supported for STRING type".
 */
const GEMINI_REJECTED_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'default',
  'format',
]);

/**
 * Placeholder property of an otherwise empty OBJECT schema. The Gemini backend
 * rejects such a schema with "properties: should be non-empty for OBJECT type".
 */
const EMPTY_OBJECT_PLACEHOLDER = 'dummy_DO_NOT_GENERATE';

/**
 * Normalizes an OpenAPI schema key to the corresponding `Schema` field name.
 *
 * The key is snake_cased first so that a separator, an acronym or a spelling
 * the OpenAPI document chose is folded away, then lower camel cased because
 * that is how `@google/genai` spells its field names.
 */
function toGeminiSchemaField(key: string): string {
  return toSnakeCaseName(key).replace(
    /_([a-z0-9])/g,
    (_match, letter: string) => letter.toUpperCase(),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function convertSchemaField(field: string, value: unknown): unknown {
  if (field === 'type') {
    return toGeminiType(typeof value === 'string' ? value : undefined);
  }
  if (field === 'properties' && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, property]) => [
        name,
        openApiSchemaToGeminiSchema(property),
      ]),
    );
  }
  if (field === 'items' && isPlainObject(value)) {
    return openApiSchemaToGeminiSchema(value);
  }
  if (field === 'anyOf' && Array.isArray(value)) {
    return value.map((item) => openApiSchemaToGeminiSchema(item));
  }
  return value;
}

/**
 * Converts an OpenAPI schema to a Gemini `Schema`.
 *
 * This is the counterpart of `toGeminiSchema` for an arbitrary OpenAPI schema
 * rather than an MCP tool input schema. An OpenAPI document may carry any key
 * it likes, so a key the Gemini `Schema` does not declare is dropped instead of
 * being forwarded to a backend that rejects it.
 *
 * @param openApiSchema The OpenAPI schema, which may be any value.
 * @returns The converted schema, or `undefined` when there is no input.
 * @throws {TypeError} If the input is neither an object nor nullish.
 */
export function openApiSchemaToGeminiSchema(
  openApiSchema?: unknown,
): Schema | undefined {
  if (openApiSchema === undefined || openApiSchema === null) {
    return undefined;
  }
  if (!isPlainObject(openApiSchema)) {
    throw new TypeError('openapi_schema must be a dictionary');
  }

  const source: Record<string, unknown> = {...openApiSchema};
  // A schema with no type at all fails with "one_of or any_of must specify a
  // type", so an untyped schema is treated as an object.
  if (!source['type']) {
    source['type'] = 'object';
  }
  const properties = source['properties'];
  const hasProperties =
    isPlainObject(properties) && Object.keys(properties).length > 0;
  if (source['type'] === 'object' && !hasProperties) {
    source['properties'] = {[EMPTY_OBJECT_PLACEHOLDER]: {type: 'string'}};
  }

  // Every key is checked against GEMINI_SCHEMA_FIELDS before it is written, so
  // the accumulated record holds only fields the Gemini `Schema` declares.
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = toGeminiSchemaField(key);
    if (
      !GEMINI_SCHEMA_FIELDS.has(field) ||
      GEMINI_REJECTED_SCHEMA_FIELDS.has(field)
    ) {
      continue;
    }
    converted[field] = convertSchemaField(field, value);
  }
  return converted as Schema;
}
