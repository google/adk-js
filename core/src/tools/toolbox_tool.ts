/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LangchainTool, LangchainToolLike} from './langchain_tool.js';

/**
 * Structural interface for a Toolbox client instance.
 */
export interface ToolboxClientLike {
  /**
   * Loads a single tool by name (camelCase convention).
   */
  loadTool?: (toolName: string) => LangchainToolLike;

  /**
   * Loads a single tool by name (snake_case convention).
   */
  load_tool?: (toolName: string) => LangchainToolLike;

  /**
   * Loads a toolset by name (camelCase convention).
   */
  loadToolset?: (toolsetName: string) => LangchainToolLike[];

  /**
   * Loads a toolset by name (snake_case convention).
   */
  load_toolset?: (toolsetName: string) => LangchainToolLike[];
}

/**
 * Configuration options for {@link ToolboxTool}.
 */
export interface ToolboxToolOptions {
  /**
   * The URL of the Toolbox server.
   */
  url?: string;

  /**
   * Optional pre-configured Toolbox client instance.
   */
  client?: ToolboxClientLike;
}

const TOOLBOX_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.toolboxTool');

/**
 * Type guard to check if an object is an instance of {@link ToolboxTool}.
 */
export function isToolboxTool(obj: unknown): obj is ToolboxTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    TOOLBOX_TOOL_SIGNATURE_SYMBOL in obj &&
    (obj as Record<symbol, unknown>)[TOOLBOX_TOOL_SIGNATURE_SYMBOL] === true
  );
}

function createUnconfiguredToolboxClient(url?: string): ToolboxClientLike {
  const endpoint = url ?? 'unspecified URL';
  const throwMissingClient = (): never => {
    throw new Error(
      `ToolboxTool requires a ToolboxClientLike instance (for endpoint "${endpoint}"). Pass {url, client} to the ToolboxTool constructor.`,
    );
  };
  return {
    loadTool: throwMissingClient,
    loadToolset: throwMissingClient,
  };
}

/**
 * Provides access to Toolbox tools and toolsets wrapped as {@link LangchainTool}
 * instances.
 */
export class ToolboxTool {
  /** A unique symbol to identify ADK ToolboxTool class. */
  readonly [TOOLBOX_TOOL_SIGNATURE_SYMBOL] = true;

  /**
   * The URL of the Toolbox server, if provided.
   */
  readonly url?: string;

  /**
   * The underlying Toolbox client.
   */
  readonly toolboxClient: ToolboxClientLike;

  constructor(urlOrOptions: string | ToolboxToolOptions) {
    if (typeof urlOrOptions === 'string') {
      this.url = urlOrOptions;
      this.toolboxClient = createUnconfiguredToolboxClient(urlOrOptions);
    } else {
      this.url = urlOrOptions.url;
      this.toolboxClient =
        urlOrOptions.client ??
        createUnconfiguredToolboxClient(urlOrOptions.url);
    }
  }

  /**
   * Loads a single tool from the Toolbox client and wraps it in a
   * {@link LangchainTool}.
   */
  getTool(toolName: string): LangchainTool {
    const loader =
      this.toolboxClient.loadTool?.bind(this.toolboxClient) ??
      this.toolboxClient.load_tool?.bind(this.toolboxClient);
    if (!loader) {
      throw new Error(
        'ToolboxClient does not implement loadTool or load_tool.',
      );
    }
    const tool = loader(toolName);
    return new LangchainTool(tool);
  }

  /**
   * Loads a toolset from the Toolbox client and wraps each tool in a
   * {@link LangchainTool}.
   */
  getToolset(toolsetName: string): LangchainTool[] {
    const loader =
      this.toolboxClient.loadToolset?.bind(this.toolboxClient) ??
      this.toolboxClient.load_toolset?.bind(this.toolboxClient);
    if (!loader) {
      throw new Error(
        'ToolboxClient does not implement loadToolset or load_toolset.',
      );
    }
    const tools = loader(toolsetName);
    return tools.map((tool) => new LangchainTool(tool));
  }
}
