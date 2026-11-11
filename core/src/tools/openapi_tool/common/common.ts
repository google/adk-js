/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {
  renameReservedKeywords,
  toSnakeCaseName,
} from '../../../utils/case_utils.js';
import {ApiParameter} from '../openapi_spec_parser/operation_parser.js';

/**
 * The type hints these helpers emit are Python tokens, in a TypeScript SDK,
 * on purpose. They are assembled into a tool description that reaches the
 * model, so the same OpenAPI operation has to describe itself identically in
 * adk-js and in adk-python. The reference is adk-python
 * `src/google/adk/tools/openapi_tool/common/common.py`.
 */
/** Input to {@link createApiParameter}; `name` is derived when omitted. */
export interface ApiParameterInit {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name?: string;
  required?: boolean;
}

const ANY_TYPE_HINT = 'Any';
const PARAM_PROPERTY_INDENT = '       ';
const RETURN_PROPERTY_INDENT = '        ';

/**
 * Python type names for the OpenAPI schema types.
 *
 * The generated documentation is a Python-style docstring, so the type
 * vocabulary stays Python's. The string reaches the model as part of a tool
 * description, and identical text across the two SDKs gives identical model
 * behaviour for the same spec.
 */
const TYPE_HINTS: Readonly<Record<string, string>> = {
  integer: 'int',
  number: 'float',
  boolean: 'bool',
  string: 'str',
  object: 'Dict[str, Any]',
};

/**
 * Returns the Python type hint for an OpenAPI schema.
 *
 * @param schema The schema to describe, if any.
 * @returns A Python type name such as `str`, `List[int]` or `Dict[str, Any]`.
 *     A missing or unrecognised type gives `Any`.
 */
export function getTypeHint(
  schema: OpenAPIV3.SchemaObject | undefined,
): string {
  if (!schema?.type) {
    return ANY_TYPE_HINT;
  }
  if (schema.type === 'array') {
    return `List[${getArrayItemTypeHint(schema.items)}]`;
  }
  return TYPE_HINTS[schema.type] ?? ANY_TYPE_HINT;
}

function getArrayItemTypeHint(
  items: OpenAPIV3.ArraySchemaObject['items'],
): string {
  const itemType = resolveSchema(items)?.type;
  // A nested array has no Python hint of its own here, matching the reference.
  if (!itemType || itemType === 'array') {
    return ANY_TYPE_HINT;
  }
  return TYPE_HINTS[itemType] ?? ANY_TYPE_HINT;
}

/**
 * Generates the docstring line documenting one parameter.
 *
 * @param param The parameter to document.
 * @returns A line of the form `name (type): description`, followed by an
 *     indented property list when the schema is an object with properties.
 */
export function generateParamDoc(param: ApiParameter): string {
  const description = param.description?.trim() ?? '';
  const typeHint = getTypeHint(param.paramSchema);
  return (
    `${param.name} (${typeHint}): ${description}` +
    describeProperties(param.paramSchema, PARAM_PROPERTY_INDENT)
  );
}

/**
 * Generates the docstring block documenting the return value.
 *
 * Uses the 2xx response with the smallest status code that has content.
 *
 * @param responses The responses of an OpenAPI operation.
 * @returns A line of the form `Returns (type): description`, or `''` when no
 *     2xx response has content.
 */
export function generateReturnDoc(
  responses: OpenAPIV3.ResponsesObject,
): string {
  // Numeric 2xx codes first, in numeric order, then wildcards such as `2XX`.
  // The reference sorts with `int(code)`, which raises on a wildcard and so
  // never reaches one; accepting it is a deliberate superset, because a spec
  // that documents only `2XX` otherwise gets no return documentation at all.
  const response = Object.entries(responses)
    .filter(([code]) => /^2(\d\d|XX)$/i.test(code))
    .sort(([a], [b]) => {
      const numeric = (c: string) => (/^\d+$/.test(c) ? Number(c) : Infinity);
      return numeric(a) - numeric(b);
    })
    .map(([, value]) => value)
    .find(hasContent);

  if (!response) {
    return '';
  }

  const description = (response.description || '').trim();
  const firstMimeType = Object.keys(response.content)[0];
  const schema = resolveSchema(response.content[firstMimeType]?.schema);

  return (
    `Returns (${getTypeHint(schema)}): ${description}` +
    describeProperties(schema, RETURN_PROPERTY_INDENT)
  );
}

/** A response whose `content` is present, so the caller needs no second guard. */
type ResponseWithContent = OpenAPIV3.ResponseObject & {
  content: NonNullable<OpenAPIV3.ResponseObject['content']>;
};

function hasContent(
  response: OpenAPIV3.ReferenceObject | OpenAPIV3.ResponseObject,
): response is ResponseWithContent {
  // An empty `content` map has no media type and therefore no schema, so it
  // is not a usable response.
  return (
    !('$ref' in response) &&
    response.content !== undefined &&
    Object.keys(response.content).length > 0
  );
}

function resolveSchema(
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | undefined,
): OpenAPIV3.SchemaObject | undefined {
  return schema && !('$ref' in schema) ? schema : undefined;
}

function describeProperties(
  schema: OpenAPIV3.SchemaObject | undefined,
  indent: string,
): string {
  if (schema?.type !== 'object') {
    return '';
  }
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) {
    return '';
  }
  return properties.reduce((doc, [propName, propDetails]) => {
    const propSchema = resolveSchema(propDetails);
    // A `$ref` the parser has not resolved describes nothing useful. Rendering
    // it as `Any` would put a meaningless line in the tool description the
    // model reads, so it is skipped.
    if (!propSchema) {
      return doc;
    }
    const propDesc = propSchema.description ?? '';
    return `${doc}${indent}${propName} (${getTypeHint(propSchema)}): ${propDesc}\n`;
  }, ' Object properties:\n');
}

/**
 * Builds an {@link ApiParameter}, deriving the fields adk-python derives in
 * `ApiParameter.model_post_init`.
 *
 * `name` falls back to the reserved-word-safe snake_case form of
 * `originalName`, and `description` falls back to the schema description.
 *
 * @param init The parameter fields.
 * @returns The parameter with its derived fields filled in.
 */
export function createApiParameter(init: ApiParameterInit): ApiParameter {
  return {
    originalName: init.originalName,
    paramLocation: init.paramLocation,
    paramSchema: init.paramSchema,
    description: init.description || init.paramSchema.description || '',
    name:
      init.name || renameReservedKeywords(toSnakeCaseName(init.originalName)),
    required: init.required ?? false,
  };
}
