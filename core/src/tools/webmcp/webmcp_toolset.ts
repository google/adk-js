/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {WebMCPTool} from './webmcp_tool.js';
import {getModelContext, WebMCPDocument} from './webmcp_types.js';

/** Options for {@link WebMCPToolset}. */
export interface WebMCPToolsetOptions {
  /** Restricts which tools reach the model, by name or predicate. */
  toolFilter?: ToolPredicate | string[];
  /** Prefixes every discovered tool name with `${prefix}_`. */
  prefix?: string;
  /**
   * Secure origins to also collect tools from, for cross-origin iframes. A
   * cross-origin tool is only returned if its page also exposed it to this
   * origin via `exposedTo`.
   */
  fromOrigins?: string[];
  /** Document to read `modelContext` from. Defaults to the global document. */
  document?: WebMCPDocument;
}

/**
 * A toolset backed by the tools a web page registers with WebMCP.
 *
 * WebMCP lets a page declare typed, callable tools on `document.modelContext`.
 * This toolset surfaces them to an in-browser agent, so the agent drives the
 * page through the handlers it published instead of scraping the DOM. Each
 * tool's own `execute` runs in the page, so its UI updates as a side effect.
 *
 * Unlike {@link MCPToolset}, nothing is transported anywhere: discovery and
 * execution are same-document browser calls.
 *
 * Outside a browser, or in a browser without WebMCP, `getTools()` returns an
 * empty array rather than throwing, so this is safe to construct anywhere.
 *
 * @example
 * ```ts
 * import {LlmAgent} from '@google/adk';
 * import {WebMCPToolset} from '@google/adk/tools/webmcp';
 *
 * const agent = new LlmAgent({
 *   name: 'page_agent',
 *   model: 'gemini-3.8-live',
 *   tools: [new WebMCPToolset()],
 * });
 * ```
 *
 * @see https://developer.chrome.com/docs/ai/webmcp
 */
export class WebMCPToolset extends BaseToolset {
  private readonly doc?: WebMCPDocument;
  private readonly fromOrigins?: string[];
  private readonly changeListeners = new Set<() => void>();

  constructor(options: WebMCPToolsetOptions = {}) {
    super(options.toolFilter ?? [], options.prefix);
    this.doc = options.document;
    this.fromOrigins = options.fromOrigins;
  }

  /** Whether this document exposes WebMCP. */
  isSupported(): boolean {
    return !!getModelContext(this.doc);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const modelContext = getModelContext(this.doc);
    if (!modelContext) {
      logger.debug(
        'document.modelContext is unavailable; WebMCPToolset is exposing no tools.',
      );
      return [];
    }

    const registered = await modelContext.getTools(
      this.fromOrigins ? {fromOrigins: this.fromOrigins} : undefined,
    );

    const tools = registered.map(
      (tool) =>
        new WebMCPTool({
          tool,
          name: this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
          document: this.doc,
        }),
    );

    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return tools;
    }
    if (Array.isArray(filter)) {
      return tools.filter((tool) => filter.includes(tool.name));
    }
    if (context) {
      return tools.filter((tool) => filter(tool, context));
    }
    logger.warn(
      'WebMCPToolset: a ToolPredicate toolFilter was provided but getTools() was called without a ReadonlyContext. The filter will not be applied.',
    );
    return tools;
  }

  /**
   * Subscribes to the WebMCP `toolchange` event, which fires when the page
   * registers or removes tools. Returns an unsubscribe function.
   */
  onToolChange(listener: () => void): () => void {
    const modelContext = getModelContext(this.doc);
    if (!modelContext) return () => {};

    const handler = () => listener();
    this.changeListeners.add(handler);
    modelContext.addEventListener('toolchange', handler);

    return () => {
      modelContext.removeEventListener('toolchange', handler);
      this.changeListeners.delete(handler);
    };
  }

  override async close(): Promise<void> {
    const modelContext = getModelContext(this.doc);
    if (modelContext) {
      for (const handler of this.changeListeners) {
        modelContext.removeEventListener('toolchange', handler);
      }
    }
    this.changeListeners.clear();
  }
}
