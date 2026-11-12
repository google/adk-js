/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
import {BaseTool, isBaseTool} from './base_tool.js';
import {BaseToolset, ToolPredicate} from './base_toolset.js';
import {
  FunctionTool,
  ToolExecuteFunction,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

/**
 * Structural interface for a tool loaded from a Toolbox client.
 */
export interface ToolboxToolLike {
  /**
   * The name of the tool.
   */
  name?: string;

  /**
   * The description of the tool.
   */
  description?: string;

  /**
   * Optional parameter schema for the tool.
   */
  parameters?: ToolInputParameters;

  /**
   * Executes the tool with the given arguments.
   */
  execute?(...args: never[]): unknown | Promise<unknown>;
}

/**
 * Options forwarded to a Toolbox client when loading a tool or toolset.
 */
export interface ToolboxLoadOptions {
  /**
   * Mapping of authentication service names to functions that return the
   * corresponding authentication token.
   */
  authTokenGetters?: Record<string, () => string | Promise<string>>;

  /**
   * Mapping of parameter names to bind to fixed values or functions that
   * produce values as needed.
   */
  boundParams?: Record<string, unknown>;
}

/**
 * Structural interface for an asynchronous or synchronous Toolbox client
 * instance used by {@link ToolboxToolset}.
 */
export interface ToolboxToolsetClientLike {
  /**
   * Loads a single tool by name.
   */
  loadTool?: (
    toolName: string,
    authTokenGetters?: Record<string, () => string | Promise<string>>,
    boundParams?: Record<string, unknown>,
  ) =>
    | BaseTool
    | ToolboxToolLike
    | ((...args: never[]) => unknown)
    | Promise<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>;

  /**
   * Loads a toolset by name.
   */
  loadToolset?: (
    toolsetName: string,
    authTokenGetters?: Record<string, () => string | Promise<string>>,
    boundParams?: Record<string, unknown>,
  ) =>
    | Array<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>
    | Promise<
        Array<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>
      >;

  /**
   * Closes the underlying client resources.
   */
  close?: () => void | Promise<void>;
}

/**
 * Configuration options for {@link ToolboxToolset}.
 */
export interface ToolboxToolsetOptions {
  /**
   * The URL of the Toolbox server. Required when `client` is not provided.
   */
  serverUrl?: string;

  /**
   * The name of the Toolbox toolset to load.
   */
  toolsetName?: string;

  /**
   * The names of the individual tools to load.
   */
  toolNames?: readonly string[];

  /**
   * Mapping of authentication service names to functions that return the
   * corresponding authentication token.
   */
  authTokenGetters?: Record<string, () => string | Promise<string>>;

  /**
   * Mapping of parameter names to bind to fixed values or functions that
   * produce values as needed.
   */
  boundParams?: Record<string, unknown>;

  /**
   * Optional pre-configured Toolbox client instance.
   */
  client?: ToolboxToolsetClientLike;

  /**
   * Optional filter to select which tools are exposed to the LLM.
   */
  toolFilter?: ToolPredicate | string[];

  /**
   * Optional prefix prepended (`${prefix}_`) to loaded tool names.
   */
  prefix?: string;
}

const TOOLBOX_TOOLSET_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.toolboxToolset',
);

/**
 * Type guard to check if an object is an instance of {@link ToolboxToolset}.
 */
export function isToolboxToolset(obj: unknown): obj is ToolboxToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    TOOLBOX_TOOLSET_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[TOOLBOX_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

const TOOLBOX_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.toolboxTool');

/**
 * Type guard to check if an object is a tool loaded by a
 * {@link ToolboxToolset}.
 */
export function isToolboxTool(obj: unknown): obj is BaseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    TOOLBOX_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[TOOLBOX_TOOL_SIGNATURE_SYMBOL] === true
  );
}

function createUnconfiguredToolboxToolsetClient(
  serverUrl: string,
): ToolboxToolsetClientLike {
  const throwMissingClient = (): never => {
    throw new Error(
      `ToolboxToolset requires a ToolboxToolsetClientLike instance (for endpoint "${serverUrl}"). Pass {serverUrl, client} to the ToolboxToolset constructor.`,
    );
  };
  return {
    loadTool: throwMissingClient,
    loadToolset: throwMissingClient,
    close: () => {},
  };
}

function isToolOptionsObject(
  value: unknown,
): value is ToolOptions<ToolInputParameters> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof (value as {execute?: unknown}).execute === 'function'
  );
}

// A proxy leaves the loaded tool untouched, so frozen tools work, and binds
// methods to it, so its private fields and state keep working.
function wrapToolboxTool(rawTool: BaseTool, name: string): BaseTool {
  return new Proxy(rawTool, {
    has(target, prop) {
      return (
        prop === TOOLBOX_TOOL_SIGNATURE_SYMBOL || Reflect.has(target, prop)
      );
    },
    get(target, prop) {
      if (prop === TOOLBOX_TOOL_SIGNATURE_SYMBOL) {
        return true;
      }
      if (prop === 'name') {
        return name;
      }
      if (prop === '_getDeclaration') {
        return () => {
          const declaration = target._getDeclaration();
          return declaration ? {...declaration, name} : undefined;
        };
      }
      const value = Reflect.get(target, prop, target);
      const own = Reflect.getOwnPropertyDescriptor(target, prop);
      if (own && !own.configurable && !own.writable) {
        return value;
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface ToolboxSdkFunction {
  toolName?: string;
  description?: string;
  parameters?: ToolInputParameters;
  getName?: () => string;
  getDescription?: () => string;
  getParamSchema?: () => ToolInputParameters;
}

function wrapLoadedTool(rawTool: unknown, prefix?: string): BaseTool {
  if (isBaseTool(rawTool)) {
    const name = prefix ? `${prefix}_${rawTool.name}` : rawTool.name;
    return wrapToolboxTool(rawTool, name);
  }

  if (typeof rawTool === 'function') {
    const fn = rawTool as ToolExecuteFunction<ToolInputParameters> &
      ToolboxSdkFunction;
    const baseName =
      typeof fn.getName === 'function'
        ? fn.getName()
        : fn.toolName ||
          (fn.name && fn.name !== 'callable' ? fn.name : undefined) ||
          'toolbox_tool';
    const name = prefix ? `${prefix}_${baseName}` : baseName;
    const description =
      typeof fn.getDescription === 'function'
        ? fn.getDescription()
        : (fn.description ?? '');
    const parameters =
      typeof fn.getParamSchema === 'function'
        ? fn.getParamSchema()
        : fn.parameters;
    return wrapToolboxTool(
      new FunctionTool({name, description, parameters, execute: fn}),
      name,
    );
  }

  if (isToolOptionsObject(rawTool)) {
    const baseTool = new FunctionTool(rawTool);
    const tool = prefix
      ? new FunctionTool({...rawTool, name: `${prefix}_${baseTool.name}`})
      : baseTool;
    return wrapToolboxTool(tool, tool.name);
  }

  throw new TypeError(
    'Unsupported Toolbox tool shape: expected a BaseTool, ToolOptions object, or function.',
  );
}

/**
 * Provides asynchronous access to Toolbox tools and toolsets as a
 * {@link BaseToolset}.
 */
export class ToolboxToolset extends BaseToolset {
  /** A unique symbol to identify ADK ToolboxToolset class. */
  readonly [TOOLBOX_TOOLSET_SIGNATURE_SYMBOL] = true;

  /**
   * The URL of the Toolbox server, if configured.
   */
  readonly serverUrl?: string;

  /**
   * The name of the Toolbox toolset to load, if configured.
   */
  readonly toolsetName?: string;

  /**
   * The names of the individual tools to load, if configured.
   */
  readonly toolNames?: readonly string[];

  /**
   * Mapping of authentication service names to token getters.
   */
  readonly authTokenGetters: Record<string, () => string | Promise<string>>;

  /**
   * Mapping of parameter names to bound values or value getters.
   */
  readonly boundParams: Record<string, unknown>;

  /**
   * The underlying Toolbox client instance.
   */
  readonly toolboxClient: ToolboxToolsetClientLike;

  constructor(options: ToolboxToolsetOptions);
  /**
   * @deprecated Use `new ToolboxToolset({serverUrl, ...options})` instead.
   */
  constructor(
    serverUrl: string,
    options: Omit<ToolboxToolsetOptions, 'serverUrl'>,
  );
  constructor(
    serverUrlOrOptions: string | ToolboxToolsetOptions,
    extraOptions?: Omit<ToolboxToolsetOptions, 'serverUrl'>,
  ) {
    const options: ToolboxToolsetOptions =
      typeof serverUrlOrOptions === 'string'
        ? {serverUrl: serverUrlOrOptions, ...extraOptions}
        : serverUrlOrOptions;

    const normalizedServerUrl = options.serverUrl?.trim();
    if (!options.client && !normalizedServerUrl) {
      throw new Error('Either client or a non-empty serverUrl is required.');
    }

    if (
      (!options.toolNames || options.toolNames.length === 0) &&
      !options.toolsetName
    ) {
      throw new Error('toolNames and toolsetName cannot both be undefined.');
    }

    super(options.toolFilter ?? [], options.prefix);
    this.serverUrl = options.serverUrl;
    this.toolsetName = options.toolsetName;
    this.toolNames = options.toolNames;
    this.authTokenGetters = options.authTokenGetters ?? {};
    this.boundParams = options.boundParams ?? {};
    this.toolboxClient =
      options.client ??
      createUnconfiguredToolboxToolsetClient(normalizedServerUrl ?? '');
  }

  /**
   * Loads the configured toolset and/or individual tools from the Toolbox
   * client and returns the selected {@link BaseTool} instances.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools: BaseTool[] = [];

    if (this.toolsetName) {
      const loader = this.toolboxClient.loadToolset?.bind(this.toolboxClient);
      if (!loader) {
        throw new Error('ToolboxClient does not implement loadToolset.');
      }
      const loadedToolset = await loader(
        this.toolsetName,
        this.authTokenGetters,
        this.boundParams,
      );
      for (const rawTool of loadedToolset) {
        tools.push(wrapLoadedTool(rawTool, this.prefix));
      }
    }

    if (this.toolNames && this.toolNames.length > 0) {
      const loader = this.toolboxClient.loadTool?.bind(this.toolboxClient);
      if (!loader) {
        throw new Error('ToolboxClient does not implement loadTool.');
      }
      const loadedSingleTools = await Promise.all(
        this.toolNames.map((toolName) =>
          loader(toolName, this.authTokenGetters, this.boundParams),
        ),
      );
      for (const rawTool of loadedSingleTools) {
        tools.push(wrapLoadedTool(rawTool, this.prefix));
      }
    }

    return tools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Closes the underlying Toolbox client.
   */
  override async close(): Promise<void> {
    await this.toolboxClient.close?.();
  }
}
