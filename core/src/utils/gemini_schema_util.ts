/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {toSnakeCaseName} from './case_utils.js';

export type MCPToolSchema = {
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

/**
 * Constraint keywords the genai `Schema` declares as strings while JSON Schema
 * spells them as numbers. The Gemini backend rejects the numeric form.
 */
const STRINGIFIED_CONSTRAINT_FIELDS = [
  'maxItems',
  'maxLength',
  'maxProperties',
  'minItems',
  'minLength',
  'minProperties',
] as const;

/** Constraint keywords the genai `Schema` declares as numbers. */
const NUMERIC_CONSTRAINT_FIELDS = ['maximum', 'minimum'] as const;

/**
 * Formats whose accompanying `pattern` is redundant: the Zod serializer emits
 * a large generated regex next to the format, and `zodObjectToSchema` has
 * always dropped it. The converter follows the same rule.
 */
const PATTERN_REDUNDANT_FORMATS: ReadonlySet<string> = new Set([
  'email',
  'uuid',
]);

/**
 * Formats the Gemini backend accepts on `INTEGER` and `NUMBER` schema fields.
 */
const GEMINI_INTEGER_NUMBER_FORMATS: ReadonlySet<string> = new Set([
  'int32',
  'int64',
]);

/**
 * Formats the Gemini backend accepts on `STRING` schema fields.
 */
const GEMINI_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'enum',
]);

function keepsGeminiFormat(type: unknown, format: unknown): boolean {
  if (typeof type !== 'string' || typeof format !== 'string') {
    return false;
  }
  if (type === 'integer' || type === 'number') {
    return GEMINI_INTEGER_NUMBER_FORMATS.has(format);
  }
  if (type === 'string') {
    return GEMINI_STRING_FORMATS.has(format);
  }
  return false;
}

/**
 * Copies the constraint keywords a genai `Schema` declares from a JSON Schema
 * node onto a `Schema` node, in the encoding the genai dialect expects.
 *
 * This is the one place that decides which constraints survive a conversion, so
 * that both converters apply the same rules: `toGeminiSchema` for a JSON Schema
 * (an MCP tool schema, or a serialized Zod response) and `zodObjectToSchema`
 * for a Zod object. Without this, every nested `minItems`/`minLength`/`minimum`
 * is silently dropped and the model is told an unconstrained schema.
 *
 * - `minItems`/`maxItems`, `minLength`/`maxLength` and
 *   `minProperties`/`maxProperties` are counts and lengths, which the genai
 *   `Schema` stores as strings.
 * - `minimum`/`maximum` stay numbers, as `Schema` declares them.
 * - `pattern` is already a string in both dialects, and survives unless it
 *   merely restates an `email`/`uuid` format.
 *
 * Every other JSON Schema keyword (`title`, `default`, `example`,
 * `exclusiveMinimum`, ...) and any unsupported `format` has no `Schema` field
 * the backend accepts, so it is still dropped.
 *
 * @param source The JSON Schema node to read the constraints from.
 * @param target The `Schema` node to write them to; may be `source` itself.
 */
export function copySchemaConstraints(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  for (const field of STRINGIFIED_CONSTRAINT_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' || typeof value === 'string') {
      target[field] = String(value);
    }
  }

  for (const field of NUMERIC_CONSTRAINT_FIELDS) {
    const value = source[field];
    if (typeof value === 'number') {
      target[field] = value;
    } else if (
      typeof value === 'string' &&
      value.trim() !== '' &&
      !Number.isNaN(Number(value))
    ) {
      target[field] = Number(value);
    }
  }

  const pattern = source['pattern'];
  const format = source['format'];
  if (typeof pattern === 'string') {
    if (typeof format === 'string' && PATTERN_REDUNDANT_FORMATS.has(format)) {
      // The source node may already carry the pattern (a `zodObjectToSchema`
      // call passes the same node in and out), so remove it as well as not
      // copying it.
      delete target['pattern'];
    } else {
      target['pattern'] = pattern;
    }
  }
}

export function toGeminiSchema(mcpSchema?: MCPToolSchema): Schema | undefined {
  if (!mcpSchema) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recursiveConvert(mcp: any): Schema {
    // JSON Schema allows boolean schemas: `true` accepts any value and `false`
    // rejects all values. Gemini has no equivalent for either, so both are
    // approximated as an unconstrained object schema, matching adk-python.
    if (typeof mcp === 'boolean') {
      mcp = {type: 'object'};
    }

    const sourceType = mcp.anyOf ?? mcp.type;
    let isNullable = false;
    let nonNullTypes;
    if (Array.isArray(sourceType)) {
      // JSON Schema allows a boolean where a schema is expected: `true` accepts
      // any value and `false` accepts none. Gemini has no equivalent for
      // either, so both become an unconstrained object, as adk-python does.
      // `anyOf` holds schemas while `type` holds type names, hence the two
      // replacement shapes.
      const fromAnyOf = Boolean(mcp.anyOf);
      const branches: MCPTypeArrayItem[] = sourceType.map(
        (branch: MCPTypeArrayItem | boolean) => {
          if (typeof branch !== 'boolean') return branch;
          return fromAnyOf ? {type: 'object'} : 'object';
        },
      );
      mcp = fromAnyOf ? {...mcp, anyOf: branches} : {...mcp, type: branches};

      nonNullTypes = branches.filter(
        (t: MCPTypeArrayItem) => getTypeFromArrayItem(t) !== 'null',
      );
      isNullable = branches.some(
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

    // The type is read here, after a nullable type array or `anyOf` has been
    // reduced to its single non-null branch and before the inference below.
    // A format survives only on a type the schema declares, never on an
    // inferred one.
    const declaredType = mcp.type;

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

    if (keepsGeminiFormat(declaredType, mcp.format)) {
      geminiSchema.format = mcp.format;
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
      // `items: false` is a schema node, so a bare truthiness test would drop
      // it. Other falsy values are not schemas and stay skipped.
      if (mcp.items || mcp.items === false) {
        geminiSchema.items = recursiveConvert(mcp.items);
      }
    }
    // Constraints are copied from the node this call started with, which by now
    // is the resolved branch: a nullable `anyOf` replaces `mcp` with its single
    // non-null branch above, so the bounds that branch carries come along.
    copySchemaConstraints(
      mcp as Record<string, unknown>,
      geminiSchema as Record<string, unknown>,
    );
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
 * Fields the Gemini backend rejects even though `Schema` declares them.
 * Unsupported `format` values (such as `date` on a STRING) are filtered by
 * {@link keepsGeminiFormat}.
 */
const GEMINI_REJECTED_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'default',
]);

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

/**
 * Normalizes a JSON Schema `type` value into a single non-null type name and a
 * `nullable` flag.
 *
 * When `type` is an array containing multiple non-null types, the first
 * non-null entry is selected as the primary Gemini schema type.
 */
export function normalizeJsonSchemaType(
  jsonSchemaType?: unknown,
): [string | undefined, boolean] {
  if (typeof jsonSchemaType === 'string') {
    if (jsonSchemaType === 'null') {
      return [undefined, true];
    }
    return [jsonSchemaType, false];
  }

  if (Array.isArray(jsonSchemaType)) {
    const nullable = jsonSchemaType.includes('null');
    const nonNullTypes = jsonSchemaType.filter(
      (t): t is string => typeof t === 'string' && t !== 'null',
    );
    return [nonNullTypes[0], nullable];
  }

  return [undefined, false];
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
  return value;
}

function isNullSchema(value: unknown): boolean {
  return isPlainObject(value) && value['type'] === 'null';
}

/**
 * Removes the `anyOf` and `oneOf` keys from `schema` and returns their
 * branches, or `undefined` when the schema has neither.
 *
 * The Gemini `Schema` has no `oneOf`, so its branches are folded into `anyOf`.
 * This widens the schema slightly: `anyOf` also accepts a value that matches
 * more than one branch. A schema may carry both keys, so the branches are
 * accumulated rather than replaced.
 */
function takeUnionBranches(
  schema: Record<string, unknown>,
): unknown[] | undefined {
  let branches: unknown[] | undefined;
  for (const [key, value] of Object.entries(schema)) {
    const field = toGeminiSchemaField(key);
    if (field !== 'anyOf' && field !== 'oneOf') {
      continue;
    }
    delete schema[key];
    if (Array.isArray(value)) {
      branches = [...(branches ?? []), ...value];
    }
  }
  return branches;
}

/**
 * Converts an OpenAPI schema to a Gemini `Schema`.
 *
 * This is the counterpart of `toGeminiSchema` for an arbitrary OpenAPI schema
 * rather than an MCP tool input schema. An OpenAPI document may carry any key
 * it likes, so a key the Gemini `Schema` does not declare is dropped instead of
 * being forwarded to a backend that rejects it.
 *
 * `oneOf` branches are folded into `anyOf`. A `{type: 'null'}` branch is
 * removed and marks the schema `nullable`. When only one branch remains, it is
 * merged into the parent schema instead of being kept as a one-item `anyOf`.
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
    throw new TypeError('openApiSchema must be a plain object');
  }

  const source: Record<string, unknown> = {...openApiSchema};
  let unionNullable = false;
  let anyOf: Schema[] | undefined;
  const branches = takeUnionBranches(source);
  if (branches) {
    const nonNullBranches = branches.filter((branch) => !isNullSchema(branch));
    unionNullable = nonNullBranches.length !== branches.length;
    if (nonNullBranches.length === 1 && isPlainObject(nonNullBranches[0])) {
      // The parent's own keys, such as `description`, describe the property
      // and take precedence over the same keys on the branch. The merged
      // schema is converted again, because the branch may itself be a union.
      const merged = openApiSchemaToGeminiSchema({
        ...nonNullBranches[0],
        ...source,
      }) as Schema;
      if (unionNullable) {
        merged.nullable = true;
      }
      return merged;
    } else if (nonNullBranches.length > 0) {
      anyOf = nonNullBranches.map(
        (branch) => openApiSchemaToGeminiSchema(branch) as Schema,
      );
    }
  }

  const [schemaType, typeNullable] = normalizeJsonSchemaType(source['type']);
  source['type'] = schemaType;
  if (typeNullable || unionNullable) {
    source['nullable'] = true;
  }
  // A schema with no type at all fails with "one_of or any_of must specify a
  // type", so an untyped schema is treated as an object. A union is left
  // untyped, because its branches carry the types.
  if (!source['type'] && !anyOf) {
    source['type'] = 'object';
  }

  // Every key is checked against GEMINI_SCHEMA_FIELDS before it is written, so
  // the accumulated record holds only fields the Gemini `Schema` declares.
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = toGeminiSchemaField(key);
    if (
      value === undefined ||
      !GEMINI_SCHEMA_FIELDS.has(field) ||
      GEMINI_REJECTED_SCHEMA_FIELDS.has(field)
    ) {
      continue;
    }
    if (field === 'format') {
      // The format is checked against the declared type, read before an
      // untyped schema defaults to an object.
      if (keepsGeminiFormat(schemaType, value)) {
        converted[field] = value;
      }
      continue;
    }
    converted[field] = convertSchemaField(field, value);
  }
  if (anyOf) {
    converted['anyOf'] = anyOf;
  }
  return converted as Schema;
}
