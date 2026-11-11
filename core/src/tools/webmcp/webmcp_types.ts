/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal structural types for the WebMCP browser API.
 *
 * Declared here rather than taken from the `webmcp-types` package so the core
 * package gains no dependency for a browser-only, still-experimental API. They
 * describe only the surface this toolset uses.
 *
 * @see https://developer.chrome.com/docs/ai/webmcp
 */

/** Metadata a page may attach to a registered tool. */
export interface WebMCPToolAnnotations {
  /** The tool only reads state. */
  readOnlyHint?: boolean;
  /** The tool's output may contain untrusted content. */
  untrustedContentHint?: boolean;
  /** The tool performs a significant or non-reversible real-world action. */
  consequentialHint?: boolean;
}

/** A tool as reported by `document.modelContext.getTools()`. */
export interface WebMCPRegisteredTool {
  name: string;
  title?: string;
  description?: string;
  /**
   * JSON Schema for the tool's arguments.
   *
   * Typed loosely on purpose: the specification says object, but browsers have
   * been observed handing back a JSON string, and a schema that is silently
   * misread leaves the model unable to pass any arguments at all.
   */
  inputSchema?: object | string;
  annotations?: WebMCPToolAnnotations;
  origin?: string;
}

/** Options accepted by `getTools()`. */
export interface WebMCPGetToolsOptions {
  /** Secure origins to include tools from, for cross-origin iframes. */
  fromOrigins?: string[];
}

/** Options accepted by `executeTool()`. */
export interface WebMCPExecuteToolOptions {
  signal?: AbortSignal;
}

/** The `document.modelContext` object. */
export interface WebMCPModelContext extends EventTarget {
  getTools(options?: WebMCPGetToolsOptions): Promise<WebMCPRegisteredTool[]>;
  executeTool(
    tool: WebMCPRegisteredTool,
    args?: unknown,
    options?: WebMCPExecuteToolOptions,
  ): Promise<unknown>;
}

/** A Document that may expose WebMCP. */
export interface WebMCPDocument {
  modelContext?: WebMCPModelContext;
}

/**
 * Returns the WebMCP entry point for a document, or undefined when the browser
 * does not expose one.
 */
export function getModelContext(
  doc?: WebMCPDocument,
): WebMCPModelContext | undefined {
  // Reached through globalThis so this module carries no DOM lib dependency
  // and stays importable from Node, matching ChromeBuiltInLlm's approach to
  // `globalThis.LanguageModel`.
  const target = doc ?? (globalThis as {document?: WebMCPDocument}).document;
  return target?.modelContext;
}

/**
 * Whether WebMCP is available.
 *
 * False outside a browser and in browsers without the API, so importing this
 * module from Node is harmless.
 */
export function isWebMCPSupported(doc?: WebMCPDocument): boolean {
  return !!getModelContext(doc);
}
