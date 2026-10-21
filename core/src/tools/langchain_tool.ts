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
  buildFunctionDeclarationForLangchain,
  buildFunctionDeclarationUtil,
  FunctionTool,
  ToolInputParameters,
} from './function_tool.js';

/**
 * Schema formats accepted on a wrapped LangChain tool.
 */
export type LangchainSchemaLike =
  | SchemaLike
  | {jsonSchema: () => Record<string, unknown>}
  | {modelJsonSchema: () => Record<string, unknown>}
  | Record<string, unknown>;

/**
 * Structural interface for a LangChain tool instance.
 */
export interface LangchainToolLike {
  /**
   * The name of the LangChain tool.
   */
  name?: string;

  /**
   * The description of the LangChain tool.
   */
  description?: string;

  /**
   * Optional parameter schema (`argsSchema`).
   */
  argsSchema?: LangchainSchemaLike;

  /**
   * Optional parameter schema (`StructuredTool.schema`).
   */
  schema?: LangchainSchemaLike;

  /**
   * Optional raw parameter properties map (`BaseTool.args`).
   */
  args?: Record<string, unknown>;

  /**
   * Executes the tool (`BaseTool._run`).
   */
  _run?(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;

  /**
   * Executes the tool (`StructuredTool._call`).
   */
  _call?(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;

  /**
   * Executes the tool (`Runnable.invoke`).
   */
  invoke?(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;

  /**
   * Executes a simple convention-based tool (`tool.run`).
   */
  run?(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;
}

/**
 * Configuration options for {@link LangchainTool}.
 */
export interface LangchainToolConfig {
  /**
   * The wrapped LangChain tool instance.
   */
  tool: LangchainToolLike;

  /**
   * Optional custom name override.
   */
  name?: string;

  /**
   * Optional custom description override.
   */
  description?: string;
}

const LANGCHAIN_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.langchainTool');

/**
 * Type guard to check if an object is an instance of {@link LangchainTool}.
 */
export function isLangchainTool(obj: unknown): obj is LangchainTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    LANGCHAIN_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[LANGCHAIN_TOOL_SIGNATURE_SYMBOL] === true
  );
}

function isLangchainToolConfig(
  value: LangchainToolConfig | LangchainToolLike,
): value is LangchainToolConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tool' in value &&
    typeof (value as LangchainToolConfig).tool === 'object' &&
    (value as LangchainToolConfig).tool !== null
  );
}

function resolveRunnerFunction(
  tool: LangchainToolLike,
): (
  args: Record<string, unknown>,
  toolContext?: Context,
) => unknown | Promise<unknown> {
  if (typeof tool._run === 'function') {
    return tool._run.bind(tool);
  }
  if (typeof tool._call === 'function') {
    return tool._call.bind(tool);
  }
  if (typeof tool.invoke === 'function') {
    return tool.invoke.bind(tool);
  }
  if (typeof tool.run === 'function') {
    return tool.run.bind(tool);
  }
  throw new TypeError(
    'LangchainTool requires a tool object with a _run, _call, invoke, or run method.',
  );
}

function isStructuredLangchainTool(tool: LangchainToolLike): boolean {
  return (
    typeof tool._run === 'function' ||
    typeof tool._call === 'function' ||
    typeof tool.invoke === 'function' ||
    tool.argsSchema !== undefined ||
    tool.schema !== undefined ||
    tool.args !== undefined
  );
}

function extractLangchainPropertiesMap(
  tool: LangchainToolLike,
): Record<string, unknown> {
  if (tool.args && typeof tool.args === 'object') {
    return structuredClone(tool.args);
  }

  const schemaSource = tool.argsSchema ?? tool.schema;
  if (!schemaSource) {
    return {};
  }

  let rawSchema: Record<string, unknown>;
  if (
    typeof (schemaSource as {modelJsonSchema?: unknown}).modelJsonSchema ===
    'function'
  ) {
    rawSchema = (
      schemaSource as {modelJsonSchema: () => Record<string, unknown>}
    ).modelJsonSchema();
  } else if (
    typeof (schemaSource as {jsonSchema?: unknown}).jsonSchema === 'function'
  ) {
    rawSchema = (
      schemaSource as {jsonSchema: () => Record<string, unknown>}
    ).jsonSchema();
  } else if (isZodSchema(schemaSource)) {
    rawSchema = structuredClone(toJsonSchema(schemaSource));
  } else {
    rawSchema = structuredClone(schemaSource as Record<string, unknown>);
  }

  const properties =
    rawSchema['properties'] && typeof rawSchema['properties'] === 'object'
      ? structuredClone(
          rawSchema['properties'] as Record<string, Record<string, unknown>>,
        )
      : (structuredClone(rawSchema) as Record<string, Record<string, unknown>>);

  const requiredSet = Array.isArray(rawSchema['required'])
    ? new Set<string>(rawSchema['required'] as string[])
    : undefined;

  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') {
      continue;
    }
    if (Array.isArray(prop['type'])) {
      const types = prop['type'] as string[];
      delete prop['type'];
      prop['anyOf'] = types.map((t) => ({type: t}));
    } else if (
      requiredSet !== undefined &&
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

  return properties;
}

/**
 * Wrapper class that adapts a LangChain tool for use in ADK.
 *
 * If the original tool name and description are not suitable, you can override
 * them in the constructor.
 */
export class LangchainTool extends FunctionTool<ToolInputParameters> {
  /** A unique symbol to identify ADK LangchainTool class. */
  readonly [LANGCHAIN_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The wrapped LangChain tool.
   */
  readonly tool: LangchainToolLike;

  constructor(
    toolOrConfig: LangchainToolConfig | LangchainToolLike,
    options?: {name?: string; description?: string},
  ) {
    const config: LangchainToolConfig = isLangchainToolConfig(toolOrConfig)
      ? toolOrConfig
      : {
          tool: toolOrConfig,
          name: options?.name,
          description: options?.description,
        };

    const runnerFn = resolveRunnerFunction(config.tool);
    const rawFn =
      config.tool._run ??
      config.tool._call ??
      config.tool.invoke ??
      config.tool.run;
    const resolvedName =
      config.name || config.tool.name || rawFn?.name || 'langchain_tool';
    const resolvedDescription =
      config.description || config.tool.description || '';
    const schemaCandidate = config.tool.argsSchema ?? config.tool.schema;

    super({
      name: resolvedName,
      description: resolvedDescription,
      parameters: isZodObject(schemaCandidate) ? schemaCandidate : undefined,
      execute: async (args: unknown, toolContext?: Context) => {
        return await runnerFn(
          (args ?? {}) as Record<string, unknown>,
          toolContext,
        );
      },
    });

    this.tool = config.tool;
  }

  /**
   * Builds the `FunctionDeclaration` for the wrapped LangChain tool.
   */
  override _getDeclaration(): FunctionDeclaration {
    try {
      if (isStructuredLangchainTool(this.tool)) {
        const propertiesMap = extractLangchainPropertiesMap(this.tool);
        const rawFn =
          this.tool._run ??
          this.tool._call ??
          this.tool.invoke ??
          this.tool.run;
        return buildFunctionDeclarationForLangchain(
          this.apiVariant === GoogleLLMVariant.VERTEX_AI,
          this.name,
          this.description,
          rawFn,
          propertiesMap,
        );
      }

      return buildFunctionDeclarationUtil(
        this.apiVariant === GoogleLLMVariant.VERTEX_AI,
        this.name,
        this.description,
        this.tool.run,
        {properties: extractLangchainPropertiesMap(this.tool)},
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to build function declaration for Langchain tool: ${message}`,
        {cause: error},
      );
    }
  }
}
