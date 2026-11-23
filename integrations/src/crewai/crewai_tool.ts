/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildFunctionDeclarationForParamsForCrewai,
  Context,
  FunctionTool,
  isZodObject,
  isZodSchema,
  type SchemaLike,
  toJsonSchema,
  type ToolInputParameters,
} from '@google/adk';
import type {FunctionDeclaration} from '@google/genai';

/**
 * Schema formats accepted on a wrapped CrewAI tool.
 */
export type CrewaiSchemaLike =
  | SchemaLike
  | {toJsonSchema: () => Record<string, unknown>}
  | {jsonSchema: () => Record<string, unknown>}
  | {modelJsonSchema: () => Record<string, unknown>}
  | Record<string, unknown>;

/**
 * Structural interface for a CrewAI tool instance.
 */
export interface CrewaiToolLike {
  /**
   * The name of the CrewAI tool.
   */
  name?: string;

  /**
   * The description of the CrewAI tool.
   */
  description?: string;

  /**
   * Optional parameters schema for the tool.
   */
  argsSchema?: CrewaiSchemaLike;

  /**
   * Executes the CrewAI tool with the given arguments.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accepts any typed tool input; unknown breaks untyped destructuring callbacks.
  run(args: any, toolContext?: Context): unknown | Promise<unknown>;
}

/**
 * Configuration options for {@link CrewaiTool}.
 */
export interface CrewaiToolConfig {
  /**
   * The wrapped CrewAI tool instance.
   */
  tool: CrewaiToolLike;

  /**
   * Optional custom name override. When omitted or empty, defaults to
   * `tool.name` with spaces replaced by underscores and lowercased.
   */
  name?: string;

  /**
   * Optional custom description override. When omitted or empty, defaults to
   * `tool.description`.
   */
  description?: string;
}

const CREWAI_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.crewaiTool');

/**
 * Type guard to check if an object is an instance of {@link CrewaiTool}.
 */
export function isCrewaiTool(obj: unknown): obj is CrewaiTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    CREWAI_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[CREWAI_TOOL_SIGNATURE_SYMBOL] === true
  );
}

function isCrewaiToolConfig(
  value: CrewaiToolConfig | CrewaiToolLike,
): value is CrewaiToolConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tool' in value &&
    typeof (value as CrewaiToolConfig).tool === 'object' &&
    (value as CrewaiToolConfig).tool !== null &&
    typeof (value as CrewaiToolConfig).tool.run === 'function'
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a schema source to a JSON Schema object that the caller owns.
 */
function readRawSchema(argsSchema: CrewaiSchemaLike): Record<string, unknown> {
  if (
    typeof (argsSchema as {toJsonSchema?: unknown}).toJsonSchema === 'function'
  ) {
    return structuredClone(
      (
        argsSchema as {toJsonSchema: () => Record<string, unknown>}
      ).toJsonSchema(),
    );
  }
  if (typeof (argsSchema as {jsonSchema?: unknown}).jsonSchema === 'function') {
    return structuredClone(
      (argsSchema as {jsonSchema: () => Record<string, unknown>}).jsonSchema(),
    );
  }
  if (
    typeof (argsSchema as {modelJsonSchema?: unknown}).modelJsonSchema ===
    'function'
  ) {
    return structuredClone(
      (
        argsSchema as {modelJsonSchema: () => Record<string, unknown>}
      ).modelJsonSchema(),
    );
  }
  if (isZodSchema(argsSchema)) {
    return structuredClone(toJsonSchema(argsSchema));
  }
  return structuredClone(argsSchema as Record<string, unknown>);
}

/**
 * Adds a `null` branch to a property schema so that the declaration builder
 * does not mark the property as required.
 */
function markOptional(prop: Record<string, unknown>): void {
  if (!('anyOf' in prop) && typeof prop['type'] === 'string') {
    const propType = prop['type'];
    delete prop['type'];
    prop['anyOf'] = [{type: propType}, {type: 'null'}];
    return;
  }
  const anyOf = prop['anyOf'];
  if (
    Array.isArray(anyOf) &&
    !anyOf.some((branch) => isPlainRecord(branch) && branch['type'] === 'null')
  ) {
    anyOf.push({type: 'null'});
  }
}

function normalizeCrewaiSchemaJson(
  argsSchema?: CrewaiSchemaLike,
): Record<string, unknown> {
  if (!argsSchema) {
    return {};
  }
  const rawSchema = readRawSchema(argsSchema);
  const properties = rawSchema['properties'];

  // A JSON Schema with a string `type` or a `$schema` key but no `properties`
  // (for example `{type: 'object'}`) has no parameters.
  if (!isPlainRecord(properties)) {
    return typeof rawSchema['type'] === 'string' ||
      typeof rawSchema['$schema'] === 'string'
      ? {}
      : rawSchema;
  }

  // In JSON Schema, an object schema without `required` requires no
  // properties. A bare `{properties}` fragment has no such list, so its fields
  // stay required unless they allow null or carry a default.
  const isJsonObjectSchema =
    rawSchema['type'] === 'object' || typeof rawSchema['$schema'] === 'string';
  const requiredSet = Array.isArray(rawSchema['required'])
    ? new Set<string>(rawSchema['required'] as string[])
    : isJsonObjectSchema
      ? new Set<string>()
      : undefined;

  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainRecord(prop)) {
      continue;
    }
    if (Array.isArray(prop['type'])) {
      const types = prop['type'] as string[];
      delete prop['type'];
      prop['anyOf'] = types.map((t) => ({type: t}));
    }
    if (
      requiredSet !== undefined &&
      !requiredSet.has(key) &&
      !('default' in prop)
    ) {
      markOptional(prop);
    }
  }
  return rawSchema;
}

/**
 * Wrapper class that adapts a CrewAI tool for use in ADK.
 *
 * If the original tool name and description are not suitable, you can override
 * them in the constructor.
 */
export class CrewaiTool extends FunctionTool<ToolInputParameters> {
  /** A unique symbol to identify ADK CrewaiTool class. */
  readonly [CREWAI_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The wrapped CrewAI tool.
   */
  readonly tool: CrewaiToolLike;

  constructor(
    toolOrConfig: CrewaiToolConfig | CrewaiToolLike,
    options?: {name?: string; description?: string},
  ) {
    const config: CrewaiToolConfig = isCrewaiToolConfig(toolOrConfig)
      ? toolOrConfig
      : {
          tool: toolOrConfig,
          name: options?.name,
          description: options?.description,
        };

    const resolvedName =
      config.name ||
      (config.tool.name
        ? config.tool.name.replace(/ /g, '_').toLowerCase()
        : config.tool.run.name || 'crewai_tool');
    const resolvedDescription =
      config.description || config.tool.description || '';

    super({
      name: resolvedName,
      description: resolvedDescription,
      parameters: isZodObject(config.tool.argsSchema)
        ? config.tool.argsSchema
        : undefined,
      execute: async (args: unknown, toolContext?: Context) => {
        return await config.tool.run(
          (args ?? {}) as Record<string, unknown>,
          toolContext,
        );
      },
    });

    this.tool = config.tool;
  }

  /**
   * Builds the `FunctionDeclaration` for the wrapped CrewAI tool.
   */
  override _getDeclaration(): FunctionDeclaration {
    const schemaJson = normalizeCrewaiSchemaJson(this.tool.argsSchema);
    // Third-party schemas are always normalized to the non-Vertex form, which
    // removes single-branch `anyOf`, `nullable`, `default` and `title` from
    // each property.
    return buildFunctionDeclarationForParamsForCrewai(
      false,
      this.name,
      this.description,
      this.tool.run,
      schemaJson,
    );
  }
}
