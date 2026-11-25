/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';

import {BaseTool} from './base_tool.js';

/**
 * Decides whether a tool should be exposed to the LLM based on the tool and
 * optional context.
 */
export type ToolPredicate = {
  bivariance(tool: BaseTool, readonlyContext?: ReadonlyContext): boolean;
}['bivariance'];

/**
 * Configuration options for {@link BaseToolset}.
 */
export interface BaseToolsetOptions {
  /**
   * Filter selecting which tools from the toolset are exposed to the LLM.
   */
  toolFilter?: ToolPredicate | string[];

  /**
   * Prefix prepended as `${toolNamePrefix}_` to tool names returned by
   * {@link BaseToolset.getToolsWithPrefix}.
   */
  toolNamePrefix?: string;

  /**
   * Legacy prefix used by subclasses that prepend prefixes inside
   * {@link BaseToolset.getTools}. Kept separate from {@link toolNamePrefix} so
   * subclass-prefixed tools are not prefixed twice.
   */
  prefix?: string;
}

function isBaseToolsetOptions(
  value: ToolPredicate | string[] | BaseToolsetOptions | undefined,
): value is BaseToolsetOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createPrefixedTool(tool: BaseTool, prefixedName: string): BaseTool {
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === 'name') {
        return prefixedName;
      }
      if (prop === '_getDeclaration') {
        return () => {
          const declaration = target._getDeclaration();
          return declaration ? {...declaration, name: prefixedName} : undefined;
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      if (
        typeof value === 'function' &&
        prop !== 'constructor' &&
        !Object.hasOwn(target, prop) &&
        Object.prototype.toString.call(value) !==
          '[object AsyncGeneratorFunction]'
      ) {
        return (...args: unknown[]) =>
          Reflect.apply(
            value as (...fnArgs: unknown[]) => unknown,
            receiver,
            args,
          );
      }
      return value;
    },
  });
}

/**
 * A unique symbol to identify ADK toolset instances.
 */
const BASE_TOOLSET_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseToolset');

/**
 * Type guard checking whether an object is an instance of {@link BaseToolset}.
 */
export function isBaseToolset(obj: unknown): obj is BaseToolset {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_TOOLSET_SIGNATURE_SYMBOL in obj &&
    obj[BASE_TOOLSET_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Base class for toolset.
 *
 * A toolset is a collection of tools that can be used by an agent.
 */
export abstract class BaseToolset {
  readonly [BASE_TOOLSET_SIGNATURE_SYMBOL] = true;

  readonly toolFilter: ToolPredicate | string[];
  readonly prefix?: string;
  readonly toolNamePrefix?: string;

  constructor(options?: BaseToolsetOptions);
  constructor(
    toolFilter?: ToolPredicate | string[],
    prefix?: string,
    toolNamePrefix?: string,
  );
  constructor(
    toolFilterOrOptions: ToolPredicate | string[] | BaseToolsetOptions = [],
    prefix?: string,
    toolNamePrefix?: string,
  ) {
    if (isBaseToolsetOptions(toolFilterOrOptions)) {
      this.toolFilter = toolFilterOrOptions.toolFilter ?? [];
      this.prefix = toolFilterOrOptions.prefix;
      this.toolNamePrefix = toolFilterOrOptions.toolNamePrefix;
    } else {
      this.toolFilter = toolFilterOrOptions;
      this.prefix = prefix;
      this.toolNamePrefix = toolNamePrefix;
    }
  }

  /**
   * Returns the tools that should be exposed to LLM.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools.
   */
  abstract getTools(context?: ReadonlyContext): Promise<BaseTool[]>;

  /**
   * Returns all tools from {@link getTools} with {@link toolNamePrefix} applied
   * when configured, without mutating the underlying tool instances.
   *
   * Subclasses should override {@link getTools} rather than this method.
   *
   * @param context Context used to filter tools available to the agent. If
   *     not defined, all tools in the toolset are returned.
   * @return A Promise that resolves to the list of tools, wrapped with prefixed
   *     names and declarations when `toolNamePrefix` is non-empty.
   */
  async getToolsWithPrefix(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = await this.getTools(context);

    if (!this.toolNamePrefix) {
      return tools;
    }

    const prefix = this.toolNamePrefix;
    return tools.map((tool) =>
      createPrefixedTool(tool, `${prefix}_${tool.name}`),
    );
  }

  /**
   * Closes the toolset and releases any managed resources.
   *
   * Subclasses that hold open connections, files, or background handles should
   * override this method; toolsets with no resources to release may omit it.
   *
   * @return A Promise that resolves when the toolset is closed.
   */
  async close(): Promise<void> {}

  /**
   * Returns whether the tool should be exposed to LLM.
   *
   * @param tool The tool to check.
   * @param context Context used to filter tools available to the agent.
   * @return Whether the tool should be exposed to LLM.
   */
  protected isToolSelected(tool: BaseTool, context?: ReadonlyContext): boolean {
    // An empty tool filter means no filtering: all tools are selected.
    if (
      !this.toolFilter ||
      (Array.isArray(this.toolFilter) && this.toolFilter.length === 0)
    ) {
      return true;
    }

    if (typeof this.toolFilter === 'function') {
      return this.toolFilter(tool, context);
    }

    if (Array.isArray(this.toolFilter)) {
      return (this.toolFilter as string[]).includes(tool.name);
    }

    return false;
  }

  /**
   * Processes the outgoing LLM request for this toolset. This method will be
   * called before each tool processes the llm request.
   *
   * Use cases:
   * - Instead of let each tool process the llm request, we can let the toolset
   *   process the llm request. e.g. ComputerUseToolset can add computer use
   *   tool to the llm request.
   *
   * @param _toolContext The context of the tool.
   * @param _llmRequest The outgoing LLM request, mutable this method.
   */
  async processLlmRequest(
    _toolContext: Context,
    _llmRequest: LlmRequest,
  ): Promise<void> {}
}
