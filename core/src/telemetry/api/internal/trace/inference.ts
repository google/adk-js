/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GroundingChunk, GroundingMetadata} from '@google/genai';
import type {Attributes, Span} from '@opentelemetry/api';

import type {LlmRequest} from '../../../../models/llm_request.js';
import type {LlmResponse} from '../../../../models/llm_response.js';
import {AdkAttr, GenAiAttr} from '../common/attributes.js';
import {
  isExperimentalFeatureEnabled,
  shouldAddContentToSpans,
  type ResolvedTelemetryConfig,
} from '../common/config.js';
import {isReportedFinishReason} from '../common/finish_reason.js';
import {
  withoutContent,
  type OperationDetails,
} from '../common/genai_messages.js';
import {safeJsonSerialize} from '../common/serialization.js';
import {TokenUsage} from '../common/token_usage.js';
import {getTracer} from './tracer.js';

/** Parameters for {@link startInferenceSpan}. */
export interface StartInferenceSpanParams {
  readonly llmRequest: LlmRequest;
  /** Attributes the span shares with the call's log record. */
  readonly commonAttributes: Attributes;
}

/** Starts a `generate_content {model}` span under the active context. */
export function startInferenceSpan({
  llmRequest,
  commonAttributes,
}: StartInferenceSpanParams): Span {
  const config = llmRequest.config;
  return getTracer().startSpan(
    `generate_content ${llmRequest.model ?? ''}`.trim(),
    {
      attributes: {
        [GenAiAttr.OPERATION_NAME]: 'generate_content',
        [GenAiAttr.REQUEST_MODEL]: llmRequest.model ?? '',
        ...(config?.topP === undefined
          ? {}
          : {[GenAiAttr.REQUEST_TOP_P]: config.topP}),
        ...(config?.maxOutputTokens === undefined
          ? {}
          : {[GenAiAttr.REQUEST_MAX_TOKENS]: config.maxOutputTokens}),
        ...commonAttributes,
      },
    },
  );
}

/**
 * Builds the attributes one model response contributes to both the span and
 * the log record: its finish reason and its token usage.
 */
export function buildResponseAttributes(llmResponse: LlmResponse): Attributes {
  return {
    ...(isReportedFinishReason(llmResponse.finishReason)
      ? {
          [GenAiAttr.RESPONSE_FINISH_REASONS]: [
            String(llmResponse.finishReason).toLowerCase(),
          ],
        }
      : {}),
    ...(llmResponse.usageMetadata
      ? new TokenUsage(llmResponse.usageMetadata).asAttributes()
      : {}),
  };
}

function groundingSourceUris(chunks: readonly GroundingChunk[]): string[] {
  const uris = new Set<string>();
  for (const chunk of chunks) {
    for (const uri of [
      chunk.web?.uri,
      chunk.retrievedContext?.uri,
      chunk.maps?.uri,
    ]) {
      if (uri) {
        uris.add(uri);
      }
    }
  }
  return [...uris];
}

/**
 * Builds the experimental grounding attributes of a model response.
 *
 * A built-in grounding tool runs inside the model call, so the grounding
 * metadata is the only record that it ran. The counts are always recorded; the
 * queries and source URIs reveal what the user asked about, so they are
 * recorded only when content capture includes spans.
 */
function buildGroundingAttributes(
  groundingMetadata: GroundingMetadata,
  captureContent: boolean,
): Attributes {
  const queries = (groundingMetadata.webSearchQueries ?? []).filter(Boolean);
  const chunks = groundingMetadata.groundingChunks ?? [];
  const sourceUris = groundingSourceUris(chunks);
  return {
    [AdkAttr.EXPERIMENTAL_GROUNDING_QUERY_COUNT]: new Set(queries).size,
    [AdkAttr.EXPERIMENTAL_GROUNDING_CHUNK_COUNT]: chunks.length,
    ...(captureContent && queries.length > 0
      ? {[AdkAttr.EXPERIMENTAL_GROUNDING_WEB_SEARCH_QUERIES]: queries}
      : {}),
    ...(captureContent && sourceUris.length > 0
      ? {[AdkAttr.EXPERIMENTAL_GROUNDING_SOURCE_URIS]: sourceUris}
      : {}),
  };
}

/** Records one model response on its `generate_content` span. */
export function setInferenceResponseAttributes(
  span: Span,
  llmResponse: LlmResponse,
  config: ResolvedTelemetryConfig,
): void {
  span.setAttributes(buildResponseAttributes(llmResponse));
  if (
    llmResponse.groundingMetadata &&
    isExperimentalFeatureEnabled(config, 'grounding')
  ) {
    span.setAttributes(
      buildGroundingAttributes(
        llmResponse.groundingMetadata,
        shouldAddContentToSpans(config),
      ),
    );
  }
}

/**
 * Records the operation details of a model call on its span, as JSON: all of
 * them when content capture includes spans, otherwise only the view without
 * message content.
 */
export function setInferenceOperationDetails(
  span: Span,
  details: OperationDetails,
  config: ResolvedTelemetryConfig,
): void {
  const recorded = shouldAddContentToSpans(config)
    ? details
    : withoutContent(details);
  for (const [key, value] of Object.entries(recorded)) {
    span.setAttribute(key, safeJsonSerialize(value));
  }
}
