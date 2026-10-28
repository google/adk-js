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
   * Mapping of authentication service names to callables that return the
   * corresponding authentication token.
   */
  authTokenGetters?: Record<string, () => string | Promise<string>>;

  /**
   * Mapping of parameter names to bind to fixed values or callables that
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
   * Loads a single tool by name (camelCase convention).
   */
  loadTool?: (
    toolName: string,
    options?: ToolboxLoadOptions,
  ) =>
    | BaseTool
    | ToolboxToolLike
    | ((...args: never[]) => unknown)
    | Promise<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>;

  /**
   * Loads a single tool by name (snake_case convention).
   */
  load_tool?: (
    toolName: string,
    options?: ToolboxLoadOptions,
  ) =>
    | BaseTool
    | ToolboxToolLike
    | ((...args: never[]) => unknown)
    | Promise<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>;

  /**
   * Loads a toolset by name (camelCase convention).
   */
  loadToolset?: (
    toolsetName: string,
    options?: ToolboxLoadOptions,
  ) =>
    | Array<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>
    | Promise<
        Array<BaseTool | ToolboxToolLike | ((...args: never[]) => unknown)>
      >;

  /**
   * Loads a toolset by name (snake_case convention).
   */
  load_toolset?: (
    toolsetName: string,
    options?: ToolboxLoadOptions,
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
   * The URL of the Toolbox server.
   */
  serverUrl: string;

  /**
   * The name of the Toolbox toolset to load.
   */
  toolsetName?: string;

  /**
   * The names of the individual tools to load.
   */
  toolNames?: readonly string[];

  /**
   * Mapping of authentication service names to callables that return the
   * corresponding authentication token.
   */
  authTokenGetters?: Record<string, () => string | Promise<string>>;

  /**
   * Mapping of parameter names to bind to fixed values or callables that
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

function wrapLoadedTool(rawTool: unknown, prefix?: string): BaseTool {
  if (isBaseTool(rawTool)) {
    if (!prefix) {
      return rawTool;
    }
    return Object.assign(
      Object.create(Object.getPrototypeOf(rawTool)) as BaseTool,
      rawTool,
      {name: `${prefix}_${rawTool.name}`},
    );
  }

  if (typeof rawTool === 'function') {
    const fn = rawTool as ToolExecuteFunction<ToolInputParameters> & {
      description?: string;
    };
    const baseName = fn.name || 'toolbox_tool';
    const name = prefix ? `${prefix}_${baseName}` : baseName;
    const description = fn.description ?? '';
    return new FunctionTool({
      name,
      description,
      execute: fn,
    });
  }

  if (isToolOptionsObject(rawTool)) {
    const baseTool = new FunctionTool(rawTool);
    if (!prefix) {
      return baseTool;
    }
    return new FunctionTool({
      ...rawTool,
      name: `${prefix}_${baseTool.name}`,
    });
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
   * The URL of the Toolbox server.
   */
  readonly serverUrl: string;

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
      options.client ?? createUnconfiguredToolboxToolsetClient(this.serverUrl);
  }

  /**
   * Loads the configured toolset and/or individual tools from the Toolbox
   * client and returns the selected {@link BaseTool} instances.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const loadOptions: ToolboxLoadOptions = {
      authTokenGetters: this.authTokenGetters,
      boundParams: this.boundParams,
    };
    const tools: BaseTool[] = [];

    if (this.toolsetName) {
      const loader =
        this.toolboxClient.loadToolset?.bind(this.toolboxClient) ??
        this.toolboxClient.load_toolset?.bind(this.toolboxClient);
      if (!loader) {
        throw new Error(
          'ToolboxClient does not implement loadToolset or load_toolset.',
        );
      }
      const loadedToolset = await loader(this.toolsetName, loadOptions);
      for (const rawTool of loadedToolset) {
        tools.push(wrapLoadedTool(rawTool, this.prefix));
      }
    }

    if (this.toolNames && this.toolNames.length > 0) {
      const loader =
        this.toolboxClient.loadTool?.bind(this.toolboxClient) ??
        this.toolboxClient.load_tool?.bind(this.toolboxClient);
      if (!loader) {
        throw new Error(
          'ToolboxClient does not implement loadTool or load_tool.',
        );
      }
      const loadedSingleTools = await Promise.all(
        this.toolNames.map((toolName) => loader(toolName, loadOptions)),
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
