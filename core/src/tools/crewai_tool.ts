/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {Context} from '../agents/context.js';
import {SchemaLike, toJsonSchema} from '../utils/schema.js';
import {isZodObject, isZodSchema} from '../utils/simple_zod_to_json.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {
  buildFunctionDeclarationForParamsForCrewai,
  FunctionTool,
  ToolInputParameters,
} from './function_tool.js';

/**
 * Schema formats accepted on a wrapped CrewAI tool.
 */
export type CrewaiSchemaLike =
  | SchemaLike
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
  run(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;
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

function normalizeCrewaiSchemaJson(
  argsSchema?: CrewaiSchemaLike,
): Record<string, unknown> {
  if (!argsSchema) {
    return {};
  }
  if (
    typeof (argsSchema as {modelJsonSchema?: unknown}).modelJsonSchema ===
    'function'
  ) {
    return (
      argsSchema as {modelJsonSchema: () => Record<string, unknown>}
    ).modelJsonSchema();
  }
  if (typeof (argsSchema as {jsonSchema?: unknown}).jsonSchema === 'function') {
    return (
      argsSchema as {jsonSchema: () => Record<string, unknown>}
    ).jsonSchema();
  }
  if (isZodSchema(argsSchema)) {
    const raw = structuredClone(toJsonSchema(argsSchema));
    const requiredSet = new Set<string>(
      Array.isArray(raw['required']) ? (raw['required'] as string[]) : [],
    );
    const properties = raw['properties'] as
      Record<string, Record<string, unknown>> | undefined;
    if (properties && typeof properties === 'object') {
      for (const [key, prop] of Object.entries(properties)) {
        if (!prop || typeof prop !== 'object') {
          continue;
        }
        if (Array.isArray(prop['type'])) {
          const types = prop['type'] as string[];
          delete prop['type'];
          prop['anyOf'] = types.map((t) => ({type: t}));
        } else if (
          !requiredSet.has(key) &&
          !('default' in prop) &&
          !('anyOf' in prop) &&
          typeof prop['type'] === 'string'
        ) {
          const propType = prop['type'];
          delete prop['type'];
          prop['anyOf'] = [{type: propType}, {type: 'null'}];
        }
      }
    }
    return raw;
  }
  return structuredClone(argsSchema as Record<string, unknown>);
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
    return buildFunctionDeclarationForParamsForCrewai(
      this.apiVariant === GoogleLLMVariant.VERTEX_AI,
      this.name,
      this.description,
      this.tool.run,
      schemaJson,
    );
  }
}
