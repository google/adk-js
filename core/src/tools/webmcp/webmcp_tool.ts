/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {
  getModelContext,
  WebMCPDocument,
  WebMCPRegisteredTool,
} from './webmcp_types.js';

/**
 * How a browser wants `executeTool` arguments.
 *
 * Chrome first took a JSON string and later a plain object, deprecating the
 * string form in Chrome 155. Passing an object to an older build makes it parse
 * `"[object Object]"` and fail without running the tool, so the encoding is
 * probed once and reused.
 */
type ArgEncoding = 'object' | 'json-string';

/**
 * The JSON Schema shape `toGeminiSchema` accepts. WebMCP tools declare object
 * schemas, matching what the converter already handles for MCP.
 */
type WebMCPInputSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};

/**
 * The encoding negotiated per model context.
 *
 * Scoped to the context rather than the module because the answer is a
 * property of the browser that owns it: a cross-origin iframe reached through
 * `fromOrigins` may be a different implementation than the top-level document.
 * Keying it here also means the result is still shared by every tool from the
 * same page, so the probe happens once, and no module-global has to be reset
 * between tests.
 */
const argEncodingByContext = new WeakMap<object, ArgEncoding>();

/** Whether a result or error means the browser could not read the arguments. */
function isArgParseFailure(value: unknown): boolean {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value && typeof value === 'object') {
    const candidate = value as {error?: unknown; message?: unknown};
    text = String(candidate.error ?? candidate.message ?? '');
  }
  return /failed to parse input arguments|could not parse .*arguments/i.test(
    text,
  );
}

/**
 * A tool registered by the page on `document.modelContext`.
 *
 * Converts the tool's JSON Schema into a Gemini `FunctionDeclaration` and
 * executes it through `document.modelContext.executeTool()`, so the page runs
 * its own handler and updates its own UI.
 *
 * A tool annotated `consequentialHint` reports itself as requiring
 * confirmation, so significant page actions flow through ADK's existing tool
 * confirmation rather than firing unprompted.
 */
export class WebMCPTool extends BaseTool {
  private readonly doc?: WebMCPDocument;

  constructor(
    readonly webmcpTool: WebMCPRegisteredTool,
    name?: string,
    doc?: WebMCPDocument,
  ) {
    super({
      name: name ?? webmcpTool.name,
      description: webmcpTool.description ?? '',
    });
    this.doc = doc;
  }

  /**
   * The tool's JSON Schema as an object.
   *
   * `inputSchema` is specified as an object, but a browser handing back a JSON
   * string would otherwise convert to a parameterless declaration, leaving the
   * model no argument names to fill in — it then calls the tool with `{}`.
   */
  private resolveInputSchema(): WebMCPInputSchema | undefined {
    const raw: unknown = this.webmcpTool.inputSchema;
    if (raw == null) return undefined;
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as WebMCPInputSchema)
          : undefined;
      } catch {
        logger.warn(
          `WebMCP tool '${this.webmcpTool.name}' has an inputSchema string that is not valid JSON; exposing it with no parameters.`,
        );
        return undefined;
      }
    }
    if (typeof raw === 'object') return raw as WebMCPInputSchema;
    return undefined;
  }

  override _getDeclaration(): FunctionDeclaration {
    const schema = this.resolveInputSchema();
    // An explicit empty object beats TYPE_UNSPECIFIED: it says the tool takes
    // no arguments, rather than leaving the shape unknown.
    const parameters: Schema = schema
      ? (toGeminiSchema(schema) ?? {type: Type.OBJECT, properties: {}})
      : {type: Type.OBJECT, properties: {}};

    if (schema && !parameters.properties) {
      logger.warn(
        `WebMCP tool '${this.webmcpTool.name}' declared an inputSchema that produced no parameters; the model will be unable to pass arguments.`,
      );
    }

    return {
      name: this.name,
      description: this.description,
      parameters,
    };
  }

  override async checkRequireConfirmation(): Promise<boolean> {
    return !!this.webmcpTool.annotations?.consequentialHint;
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const modelContext = getModelContext(this.doc);
    if (!modelContext) {
      throw new Error(
        'document.modelContext is unavailable, so WebMCP tools cannot be executed. WebMCP requires a browser with the API enabled.',
      );
    }

    const args = request.args ?? {};
    const signal = request.toolContext?.abortSignal;
    const options = signal ? {signal} : undefined;

    const invoke = (encoding: ArgEncoding) =>
      modelContext.executeTool(
        this.webmcpTool,
        encoding === 'json-string' ? JSON.stringify(args) : args,
        options,
      );

    const known = argEncodingByContext.get(modelContext);
    if (known) {
      return await invoke(known);
    }

    // Probe the modern object form, falling back to the legacy JSON string. A
    // parse failure means the tool never ran, so the retry cannot double-apply
    // a side effect.
    let firstResult: unknown;
    try {
      firstResult = await invoke('object');
      if (!isArgParseFailure(firstResult)) {
        argEncodingByContext.set(modelContext, 'object');
        return firstResult;
      }
    } catch (err) {
      if (!isArgParseFailure(err)) throw err;
      firstResult = err;
    }

    const retried = await invoke('json-string');
    if (isArgParseFailure(retried)) {
      // Neither encoding worked; surface the original complaint.
      return firstResult;
    }
    argEncodingByContext.set(modelContext, 'json-string');
    logger.debug(
      'This browser expects JSON-string WebMCP tool arguments; using that encoding.',
    );
    return retried;
  }
}
