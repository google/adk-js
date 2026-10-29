/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';

import type {LlmRequest} from '../../../../models/llm_request.js';

/**
 * Convert any JavaScript object to a JSON-serializable string.
 *
 * @param obj The object to serialize.
 * @returns The JSON-serialized object string or '<not serializable>' if the object cannot be serialized.
 */
export function safeJsonSerialize(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (_e: unknown) {
    return '<not serializable>';
  }
}

/**
 * Returns a copy of the HTTP options without the caller-supplied fields that
 * can carry credentials.
 *
 * `headers` commonly holds an Authorization bearer token and `extraBody` is a
 * free-form request-body passthrough, so neither may reach an exported span
 * attribute. The remaining fields are useful for debugging and stay.
 *
 * @param httpOptions The HTTP options taken from the request config.
 * @returns A new HttpOptions object without `headers` and `extraBody`.
 */
export function redactHttpOptions(httpOptions: HttpOptions): HttpOptions {
  const redacted: HttpOptions = {...httpOptions};
  delete redacted.headers;
  delete redacted.extraBody;
  return redacted;
}

/**
 * Builds a dictionary representation of the LLM request for tracing.
 *
 * This function prepares a dictionary representation of the LlmRequest
 * object, suitable for inclusion in a trace. It excludes fields that cannot
 * be serialized (e.g., function pointers) and avoids sending bytes data.
 *
 * @param llmRequest The LlmRequest object.
 * @returns A dictionary representation of the LLM request.
 */
export function buildLlmRequestForTrace(
  llmRequest: LlmRequest,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: llmRequest.model,
    contents: [],
  };

  if (llmRequest.config) {
    // Create a clean config object, pruning responseSchema to reduce noise size
    const {responseSchema: _responseSchema, ...cleanConfig} = llmRequest.config;
    if (cleanConfig.httpOptions) {
      cleanConfig.httpOptions = redactHttpOptions(cleanConfig.httpOptions);
    }
    result.config = cleanConfig;
  }

  // We do not want to send bytes data to the trace.
  result.contents = llmRequest.contents.map((content) => ({
    role: content.role,
    parts: content.parts?.filter((part) => !part.inlineData) || [],
  }));

  return result;
}

/**
 * Determines whether to add request/response content to spans.
 *
 * Defaults to true for now to preserve backward compatibility.
 * Once prompt and response logging is well established in ADK, we might start
 * a deprecation of request/response content in spans by switching the default
 * to false.
 *
 * @returns false only when ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS is explicitly set to 'false' or '0'
 */
export function shouldAddRequestResponseToSpans(): boolean {
  const envValue = process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS || 'true';
  return envValue === 'true' || envValue === '1';
}
