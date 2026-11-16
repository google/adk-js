/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildFunctionDeclarationForLangchain,
  buildFunctionDeclarationUtil,
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
 * Schema formats accepted on a wrapped LangChain tool.
 */
export type LangchainSchemaLike =
  | SchemaLike
  | {toJsonSchema: () => Record<string, unknown>}
  | {jsonSchema: () => Record<string, unknown>}
  | {modelJsonSchema: () => Record<string, unknown>}
  | Record<string, unknown>;

/**
 * Structural interface for a LangChain tool that exposes public entrypoints,
 * such as a `@langchain/core` `StructuredTool`.
 */
export interface LangchainPublicToolLike {
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
   * Executes the tool (`Runnable.invoke`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accepts any SDK tool input and config type; unknown breaks untyped destructuring callbacks.
  invoke?(args: any, configOrContext?: any): unknown | Promise<unknown>;

  /**
   * Executes the tool (`Tool.call`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accepts any SDK tool input and config type; unknown breaks untyped destructuring callbacks.
  call?(args: any, configOrContext?: any): unknown | Promise<unknown>;

  /**
   * Executes a simple convention-based tool (`tool.run`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accepts any SDK tool input and config type; unknown breaks untyped destructuring callbacks.
  run?(args: any, configOrContext?: any): unknown | Promise<unknown>;

  /**
   * Executes the function wrapped by a `DynamicTool` (`func`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accepts any SDK function signature; unknown breaks untyped destructuring callbacks.
  func?(...args: any[]): unknown;
}

/**
 * Structural interface for a LangChain-style tool that exposes only the
 * internal `_run` or `_call` runner.
 */
export interface LegacyLangchainToolLike {
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
}

/**
 * Structural type for a LangChain tool instance.
 *
 * Classes and plain objects that match either shape are accepted
 * structurally. Code that reads `_run`, `_call` or `run` on a value of this
 * type must first narrow it, for example with an `in` check.
 */
export type LangchainToolLike =
  LangchainPublicToolLike | LegacyLangchainToolLike;

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

type RunnerMethod = (
  args: Record<string, unknown>,
  toolContext?: Context,
) => unknown | Promise<unknown>;

/**
 * Every runner member that either shape of {@link LangchainToolLike} can
 * carry, used to read runners without narrowing the union first.
 */
interface InternalLangchainRunnerShape {
  invoke?: RunnerMethod;
  call?: RunnerMethod;
  run?: RunnerMethod;
  func?: (...args: unknown[]) => unknown;
  _run?: RunnerMethod;
  _call?: RunnerMethod;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the first runner method on the tool, preferring public entrypoints
 * (which validate input) over the internal `_run` and `_call` methods.
 */
function resolveRawFunction(tool: LangchainToolLike): unknown {
  const candidate = tool as InternalLangchainRunnerShape;
  return (
    candidate.invoke ??
    candidate.call ??
    candidate.run ??
    candidate.func ??
    candidate._run ??
    candidate._call
  );
}

function resolveRunnerFunction(tool: LangchainToolLike): RunnerMethod {
  const candidate = tool as InternalLangchainRunnerShape;
  if (typeof candidate.invoke === 'function') {
    return candidate.invoke.bind(tool);
  }
  if (typeof candidate.call === 'function') {
    return candidate.call.bind(tool);
  }
  if (typeof candidate.run === 'function') {
    return candidate.run.bind(tool);
  }
  const func = candidate.func;
  if (typeof func === 'function') {
    // A LangChain `DynamicTool.func` reads its second argument as a run
    // manager, so the ADK context is not forwarded to it.
    return (args: Record<string, unknown>) => func.call(tool, args);
  }
  if (typeof candidate._run === 'function') {
    return candidate._run.bind(tool);
  }
  if (typeof candidate._call === 'function') {
    return candidate._call.bind(tool);
  }
  throw new TypeError(
    'LangchainTool requires a tool object with an invoke, call, run, func, _run, or _call method.',
  );
}

/**
 * Returns whether the tool exposes a public `invoke` or `call` entrypoint.
 * LangChain parses the input against the tool schema in these entrypoints.
 */
function hasValidatingEntrypoint(tool: LangchainToolLike): boolean {
  const candidate = tool as InternalLangchainRunnerShape;
  return (
    typeof candidate.invoke === 'function' ||
    typeof candidate.call === 'function'
  );
}

function isStructuredLangchainTool(tool: LangchainToolLike): boolean {
  const candidate = tool as InternalLangchainRunnerShape;
  return (
    typeof candidate.invoke === 'function' ||
    typeof candidate.call === 'function' ||
    typeof candidate.func === 'function' ||
    typeof candidate._run === 'function' ||
    typeof candidate._call === 'function' ||
    tool.argsSchema !== undefined ||
    tool.schema !== undefined ||
    tool.args !== undefined
  );
}

/**
 * Converts a schema source to a JSON Schema object that the caller owns.
 */
function readRawSchema(
  schemaSource: LangchainSchemaLike,
): Record<string, unknown> {
  if (
    typeof (schemaSource as {toJsonSchema?: unknown}).toJsonSchema ===
    'function'
  ) {
    return structuredClone(
      (
        schemaSource as {toJsonSchema: () => Record<string, unknown>}
      ).toJsonSchema(),
    );
  }
  if (
    typeof (schemaSource as {jsonSchema?: unknown}).jsonSchema === 'function'
  ) {
    return structuredClone(
      (
        schemaSource as {jsonSchema: () => Record<string, unknown>}
      ).jsonSchema(),
    );
  }
  if (
    typeof (schemaSource as {modelJsonSchema?: unknown}).modelJsonSchema ===
    'function'
  ) {
    return structuredClone(
      (
        schemaSource as {modelJsonSchema: () => Record<string, unknown>}
      ).modelJsonSchema(),
    );
  }
  if (isZodSchema(schemaSource)) {
    return structuredClone(toJsonSchema(schemaSource));
  }
  return structuredClone(schemaSource as Record<string, unknown>);
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

  const rawSchema = readRawSchema(schemaSource);

  // A JSON Schema with a string `type` or a `$schema` key but no `properties`
  // (for example `{type: 'object'}` or `{type: 'string'}`) has no parameters.
  // A raw property map never has a string `type`: its values are schemas.
  const hasProperties = isPlainRecord(rawSchema['properties']);
  const isObjectOrScalarSchema =
    hasProperties ||
    typeof rawSchema['type'] === 'string' ||
    typeof rawSchema['$schema'] === 'string';

  const properties: Record<string, Record<string, unknown>> = hasProperties
    ? (rawSchema['properties'] as Record<string, Record<string, unknown>>)
    : isObjectOrScalarSchema
      ? {}
      : (rawSchema as Record<string, Record<string, unknown>>);

  // In JSON Schema, an object schema without `required` requires no
  // properties. A bare property map has no such list, so its fields stay
  // required unless they allow null or carry a default.
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

  return properties;
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
    const rawFn = resolveRawFunction(config.tool);
    const rawFnName = typeof rawFn === 'function' ? rawFn.name : undefined;
    const resolvedName =
      config.name || config.tool.name || rawFnName || 'langchain_tool';
    const resolvedDescription =
      config.description || config.tool.description || '';
    const schemaCandidate = config.tool.argsSchema ?? config.tool.schema;
    // `invoke` and `call` parse the input themselves. A second parse here
    // would pass already transformed values to them, so the Zod schema is
    // only given to `FunctionTool` for runners that do not validate.
    // `_getDeclaration` reads the schema from `this.tool`, not from
    // `parameters`, so the declaration is the same in both cases.
    const parameters =
      !hasValidatingEntrypoint(config.tool) && isZodObject(schemaCandidate)
        ? schemaCandidate
        : undefined;

    super({
      name: resolvedName,
      description: resolvedDescription,
      parameters,
      execute: async (args: unknown, toolContext?: Context) => {
        // The ADK context goes to the runner as its second argument. A
        // LangChain `invoke` reads that argument as a `RunnableConfig` and
        // only copies its fields into the run config.
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
        // Third-party schemas are always normalized to the non-Vertex form,
        // which removes single-branch `anyOf`, `nullable`, `default` and
        // `title` from each property.
        return buildFunctionDeclarationForLangchain(
          false,
          this.name,
          this.description,
          resolveRawFunction(this.tool),
          extractLangchainPropertiesMap(this.tool),
        );
      }

      return buildFunctionDeclarationUtil(
        false,
        this.name,
        this.description,
        resolveRawFunction(this.tool),
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
