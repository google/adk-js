/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {formatError} from '../utils/error_utils.js';
import {toGeminiSchema} from '../utils/gemini_schema_util.js';
import {parseWithSchema, SchemaLike, toJsonSchema} from '../utils/schema.js';
import {
  getZodVoidOrUndefinedDescription,
  isZodObject,
  isZodSchema,
  isZodV3Schema,
  isZodVoidOrUndefined,
  zodObjectToSchema,
  ZodSchema,
} from '../utils/simple_zod_to_json.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Tool name reserved for {@link SetModelResponseTool}.
 */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

const SET_MODEL_RESPONSE_DESCRIPTION =
  'Set your final response using the required output schema. Use this tool to provide your final structured answer instead of outputting text directly.';

const SET_MODEL_RESPONSE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.setModelResponseTool',
);

/**
 * Type guard checking whether an object is an instance of
 * {@link SetModelResponseTool}.
 */
export function isSetModelResponseTool(
  obj: unknown,
): obj is SetModelResponseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    SET_MODEL_RESPONSE_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[
      SET_MODEL_RESPONSE_TOOL_SIGNATURE_SYMBOL
    ] === true
  );
}

function nonObjectZodToGenaiSchema(schema: ZodSchema): Schema {
  if (isZodVoidOrUndefined(schema)) {
    const description = getZodVoidOrUndefinedDescription(schema);
    return description ? {type: Type.NULL, description} : {type: Type.NULL};
  }
  const jsonSchema = toJsonSchema(schema);
  return (
    toGeminiSchema(jsonSchema as Parameters<typeof toGeminiSchema>[0]) ?? {
      type: Type.TYPE_UNSPECIFIED,
    }
  );
}

function isGenaiSchemaType(
  schemaType: Schema['type'] | undefined,
  expected: Type,
): boolean {
  return (
    typeof schemaType === 'string' && schemaType.toUpperCase() === expected
  );
}

function wrapNonObjectSchema(genaiSchema: Schema): {
  wrapperKey: 'items' | 'response';
  parameters: Schema;
} {
  if (
    isGenaiSchemaType(genaiSchema.type, Type.ARRAY) &&
    isGenaiSchemaType(genaiSchema.items?.type, Type.OBJECT)
  ) {
    return {
      wrapperKey: 'items',
      parameters: {
        type: Type.OBJECT,
        properties: {items: genaiSchema},
        required: ['items'],
      },
    };
  }

  return {
    wrapperKey: 'response',
    parameters: {
      type: Type.OBJECT,
      properties: {response: genaiSchema},
      required: ['response'],
    },
  };
}

function isGenaiSchema(schema: SchemaLike): schema is Schema {
  return !isZodSchema(schema);
}

type ZodObjectSchema =
  z3.ZodObject<z3.ZodRawShape> | z4.ZodObject<z4.ZodRawShape>;

function isZodV3Effects(
  schema: z3.ZodTypeAny,
): schema is z3.ZodEffects<z3.ZodTypeAny> {
  const def = schema._def;
  return (
    'typeName' in def &&
    def.typeName === z3.ZodFirstPartyTypeKind.ZodEffects &&
    'schema' in def
  );
}

function unwrapZodObject(schema: unknown): ZodObjectSchema | undefined {
  let current = schema;
  while (isZodSchema(current)) {
    if (isZodObject(current)) {
      return current;
    }
    if (isZodV3Schema(current) && isZodV3Effects(current)) {
      current = current._def.schema;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function resolveDeclarationLayout(outputSchema: SchemaLike): {
  wrapperKey?: 'items' | 'response';
  parameters: Schema;
} {
  const zodObject = unwrapZodObject(outputSchema);
  if (zodObject) {
    return {
      wrapperKey: undefined,
      parameters: zodObjectToSchema(zodObject),
    };
  }

  if (!isGenaiSchema(outputSchema)) {
    return wrapNonObjectSchema(nonObjectZodToGenaiSchema(outputSchema));
  }

  if (isGenaiSchemaType(outputSchema.type, Type.OBJECT)) {
    return {
      wrapperKey: undefined,
      parameters: outputSchema,
    };
  }

  return wrapNonObjectSchema(outputSchema);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripNullishFields(value: unknown, schemaNode?: Schema): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNullishFields(item, schemaNode?.items));
  }
  if (isPlainObject(value)) {
    const properties = schemaNode?.properties;
    // Empty `properties: {}` (e.g., `z.record(...)` via `toGeminiSchema`)
    // represents a dynamic map rather than fixed object fields, so null map
    // entries must be preserved.
    const hasDeclaredProperties =
      properties !== undefined && Object.keys(properties).length > 0;
    const required = new Set(schemaNode?.required ?? []);
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue === undefined) {
        continue;
      }
      if (entryValue === null && hasDeclaredProperties && !required.has(key)) {
        continue;
      }
      result[key] = stripNullishFields(entryValue, properties?.[key]);
    }
    return result;
  }
  return value;
}

/**
 * Internal tool enabling an `LlmAgent` to emit a schema-validated structured
 * response alongside other tools on models that do not support combining a
 * native `responseSchema` with function declarations.
 */
export class SetModelResponseTool extends BaseTool {
  readonly [SET_MODEL_RESPONSE_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The output schema validated against incoming model tool calls.
   */
  readonly outputSchema: SchemaLike;

  private readonly wrapperKey?: 'items' | 'response';
  private readonly declarationParameters: Schema;

  constructor(outputSchema: SchemaLike) {
    if (outputSchema === undefined || outputSchema === null) {
      throw new TypeError(
        'outputSchema is required to construct SetModelResponseTool.',
      );
    }

    super({
      name: SET_MODEL_RESPONSE_TOOL_NAME,
      description: SET_MODEL_RESPONSE_DESCRIPTION,
    });

    this.outputSchema = outputSchema;
    const layout = resolveDeclarationLayout(outputSchema);
    this.wrapperKey = layout.wrapperKey;
    this.declarationParameters = layout.parameters;
  }

  /**
   * Returns the `FunctionDeclaration` exposing the output schema parameters
   * to the model.
   */
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: structuredClone(this.declarationParameters),
    };
  }

  /**
   * Validates the structured model response arguments against
   * {@link outputSchema}, records the stripped result on
   * `toolContext.actions.setModelResponse`, or returns validation error feedback
   * so the model can retry.
   */
  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const candidate = this.wrapperKey ? args[this.wrapperKey] : args;
    let validated: unknown;
    try {
      validated = parseWithSchema(this.outputSchema, candidate);
    } catch (err: unknown) {
      return {
        error:
          `Validation Error found:\n${formatError(err)}\n` +
          'Recall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.',
      };
    }

    const valueSchema =
      this.wrapperKey === 'items'
        ? this.declarationParameters.properties?.['items']
        : this.wrapperKey === 'response'
          ? this.declarationParameters.properties?.['response']
          : this.declarationParameters;
    const result = stripNullishFields(validated, valueSchema);
    toolContext.actions.setModelResponse = result;
    return result;
  }
}
