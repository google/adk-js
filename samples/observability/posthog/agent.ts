/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Observability: PostHog LLM analytics
 * https://posthog.com/docs/ai-engineering/observability
 *
 * ADK emits OpenTelemetry `gen_ai.*` spans for every model call. This sample
 * routes those spans to PostHog, which converts them into `$ai_generation`
 * events server-side, so a plain agent shows up in PostHog's LLM-observability
 * product with model, token usage, latency and (optionally) prompt/response
 * content.
 *
 * The wiring is one call: hand ADK a span processor through
 * `maybeSetOtelProviders`. In your own project the processor is a one-line
 * import from PostHog's published package:
 *
 *   import {PostHogSpanProcessor} from '@posthog/ai/otel';
 *   new PostHogSpanProcessor({projectToken, host});
 *
 * This sample inlines the equivalent processor (see `createPostHogSpanProcessor`
 * below) so it stays dependency-light and adds nothing to the ADK monorepo - it
 * uses only the OpenTelemetry packages ADK already depends on, which is exactly
 * the OTLP path `@posthog/ai/otel` takes. See this directory's README for the
 * published-package version and setup.
 *
 * REQUIRES an API key (the agent calls a live model) and a PostHog project key
 * (spans are dropped otherwise). Set the environment, then run:
 *   export GEMINI_API_KEY=...
 *   export POSTHOG_API_KEY=phc_...        # PostHog project API key
 *   export POSTHOG_HOST=https://us.i.posthog.com   # or https://eu.i.posthog.com
 *   npm run sample -- samples/observability/posthog/agent.ts
 *
 * Then ask the agent something and open PostHog -> LLM analytics; the model
 * call appears as an `$ai_generation` event within a few seconds.
 */

import {LlmAgent, maybeSetOtelProviders} from '@google/adk';
import {Context} from '@opentelemetry/api';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

// PostHog treats a span as AI-related when its name or any attribute key starts
// with one of these prefixes. ADK's model-call spans carry `gen_ai.*`
// attributes, so they match; everything else is dropped before export.
const AI_SPAN_PREFIXES = ['gen_ai.', 'llm.', 'ai.', 'traceloop.'];

function isAiSpan(span: ReadableSpan): boolean {
  if (AI_SPAN_PREFIXES.some((prefix) => span.name.startsWith(prefix))) {
    return true;
  }
  return Object.keys(span.attributes ?? {}).some((key) =>
    AI_SPAN_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}

/**
 * A span processor that batches AI spans and exports them to PostHog's OTLP
 * ingestion endpoint. This mirrors `PostHogSpanProcessor` from
 * `@posthog/ai/otel`; prefer that published class in a real project.
 */
function createPostHogSpanProcessor(options: {
  projectToken: string;
  host?: string;
}): SpanProcessor {
  const host = new URL(options.host || DEFAULT_POSTHOG_HOST).origin;
  const inner = new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${host}/i/v0/ai/otel`,
      headers: {Authorization: `Bearer ${options.projectToken}`},
    }),
  );

  return {
    onStart(span: Span, parentContext: Context): void {
      inner.onStart(span, parentContext);
    },
    // Filter on end, once the span's attributes are set.
    onEnd(span: ReadableSpan): void {
      if (isAiSpan(span)) inner.onEnd(span);
    },
    shutdown(): Promise<void> {
      return inner.shutdown();
    },
    forceFlush(): Promise<void> {
      return inner.forceFlush();
    },
  };
}

// Route ADK's `gen_ai.*` spans to PostHog. `maybeSetOtelProviders` registers a
// global tracer provider only when it is given at least one span processor, so
// guarding on the key keeps the sample a no-op until PostHog is configured.
const projectToken = process.env.POSTHOG_API_KEY ?? '';
if (projectToken) {
  maybeSetOtelProviders([
    {
      spanProcessors: [
        createPostHogSpanProcessor({
          projectToken,
          // Defaults to https://us.i.posthog.com when unset.
          host: process.env.POSTHOG_HOST,
        }),
      ],
    },
  ]);
} else {
  console.warn(
    'POSTHOG_API_KEY is not set; running without PostHog telemetry. ' +
      'Set it to a phc_... project key to see $ai_generation events.',
  );
}

export const rootAgent = new LlmAgent({
  name: 'posthog_observability_agent',
  model: 'gemini-flash-latest',
  description: 'A minimal agent whose model calls are traced to PostHog.',
  instruction:
    'You are a concise assistant. Answer the user in a sentence or two.',
});
