/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';

import {BasePlugin} from './base_plugin.js';

/**
 * Runtime Contract v1.1 — LlmRequest capture plugin.
 *
 * Mirrors adk-python's `evaluation/request_intercepter_plugin.py`. Extends
 * BasePlugin to capture the fully-resolved LlmRequest right before each LLM
 * call. Enables `hallucinations_v1` and precision `rubric_based_*` metrics
 * over HTTP by exposing what the LLM was actually shown — content that the
 * default Runtime Contract v1 wire never carries.
 *
 * NOTE: intended for eval systems internal usage. Not part of the public API
 * surface. Instantiated per HTTP request by the /run_sse handler when the
 * server-level kill switch (`ADK_ENABLE_LLM_CAPTURE=1`) is on AND the client
 * opted in via `?capture=llm_request`.
 */

/**
 * One captured LlmRequest snapshot, serializable for the wire.
 *
 * Matches the shape of `LlmRequestCapture` in
 * `spec/runtime-contract-v1.1.openapi.yaml`.
 */
export interface CapturedLlmRequest {
  invocationId: string;
  step: number;
  agentName?: string;
  model: string;
  systemInstruction?: string;
  contents: unknown[];
  tools?: unknown[];
  generateContentConfig?: Record<string, unknown>;
  cacheHit?: boolean;
  timestamp: number;
}

/**
 * Plugin that captures LlmRequest per LLM call. One instance per HTTP
 * request; discarded when the request completes.
 */
export class RequestIntercepterPlugin extends BasePlugin {
  private readonly stepByInvocation = new Map<string, number>();

  /** Captures accumulated during the current HTTP request's lifetime. */
  readonly captures: CapturedLlmRequest[] = [];

  constructor() {
    super('RequestIntercepterPlugin');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const invocationCtx = params.callbackContext.invocationContext;
    const invocationId = invocationCtx?.invocationId ?? '';
    const step = this.stepByInvocation.get(invocationId) ?? 0;
    this.stepByInvocation.set(invocationId, step + 1);

    const req = params.llmRequest;

    this.captures.push({
      invocationId,
      step,
      agentName: invocationCtx?.agent?.name,
      model: req.model ?? 'unknown',
      systemInstruction: req.config?.systemInstruction as string | undefined,
      // structuredClone gives us a wire-safe snapshot (defensive against
      // later in-place mutation by other plugins between capture and drain).
      contents: structuredClone(req.contents ?? []),
      tools: extractToolDeclarations(req),
      generateContentConfig: sanitizeConfig(req.config),
      cacheHit: undefined, // adk-js does not currently expose cache-hit info
      timestamp: Date.now() / 1000,
    });

    // Returning undefined → proceed with the actual LLM call as normal.
    return undefined;
  }

  /**
   * Consume + clear any captures accumulated so far.
   *
   * The /run_sse handler drains this before writing each Event frame, so
   * `event: llm_request` frames precede the Event frame(s) they produced
   * on the wire — natural per-call ordering.
   */
  drain(): CapturedLlmRequest[] {
    const taken = this.captures.slice();
    this.captures.length = 0;
    return taken;
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Extract per-tool JSON schemas the LLM actually saw, as a serializable list.
 * Skips `toolsDict` (BaseTool object references — not wire-safe).
 */
function extractToolDeclarations(req: LlmRequest): unknown[] | undefined {
  const tools = req.config?.tools;
  if (!tools) return undefined;

  const out: unknown[] = [];
  for (const toolBlock of tools) {
    // ToolUnion may be an object with functionDeclarations[] (regular case)
    // or a CallableTool (built-in). We only serialize the shape we know.
    const decls = (toolBlock as {functionDeclarations?: unknown[]})
      .functionDeclarations;
    if (Array.isArray(decls)) {
      for (const d of decls) {
        out.push(d);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Return the config with only wire-safe fields. Drops the `tools` array
 * (already extracted separately) and `systemInstruction` (already surfaced
 * top-level in `CapturedLlmRequest.systemInstruction`) to avoid redundancy
 * on the wire.
 */
function sanitizeConfig(config: unknown): Record<string, unknown> | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const clone: Record<string, unknown> = {
    ...(config as Record<string, unknown>),
  };
  delete clone['tools'];
  delete clone['systemInstruction'];
  return clone;
}
