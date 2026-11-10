/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Attributes,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
} from '@opentelemetry/api';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE, SCHEMA_URL} from '../common/attributes.js';
import {
  CACHE_READ_INPUT_TOKENS_MEANING,
  INPUT_TOKENS_MEANING,
  OUTPUT_TOKENS_MEANING,
  REASONING_OUTPUT_TOKENS_MEANING,
  type TokenUsage,
  TOOL_INPUT_TOKENS_MEANING,
  TOTAL_TOKENS_MEANING,
} from '../common/token_usage.js';

/**
 * Advisory bucket boundaries for per-invocation and per-workflow call-count
 * histograms. Upper-inclusive, so the leading `0` buckets exact zeros on their
 * own.
 */
export const CALL_COUNT_BUCKETS: readonly number[] = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64, 128, 256, 512,
]);

/**
 * Advisory bucket boundaries for input, total, cache-read, and tool-input
 * token histograms.
 */
export const INPUT_TOKEN_BUCKETS: readonly number[] = Object.freeze([
  0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144,
  524288, 1048576,
]);

/**
 * Advisory bucket boundaries for output and reasoning token histograms.
 */
export const OUTPUT_TOKEN_BUCKETS: readonly number[] = Object.freeze([
  0, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
]);

/**
 * Lazily builds and caches one set of domain instruments per registered
 * `MeterProvider`, so a provider registered after ADK is imported still
 * receives metrics under the ADK instrumentation scope and schema URL.
 */
export function cachedInstruments<T>(create: (meter: Meter) => T): () => T {
  const cache = new WeakMap<MeterProvider, T>();
  return (): T => {
    const provider = metrics.getMeterProvider();
    let instruments = cache.get(provider);
    if (instruments === undefined) {
      instruments = create(
        provider.getMeter(GEN_AI_SYSTEM_VALUE, version, {
          schemaUrl: SCHEMA_URL,
        }),
      );
      cache.set(provider, instruments);
    }
    return instruments;
  };
}

/** Parameters for {@link createHistogram}. */
export interface CreateHistogramParams {
  readonly meter: Meter;
  readonly name: string;
  readonly unit: string;
  readonly description: string;
  readonly buckets?: readonly number[];
}

/** Creates a histogram with optional advisory bucket boundaries. */
export function createHistogram({
  meter,
  name,
  unit,
  description,
  buckets,
}: CreateHistogramParams): Histogram {
  return meter.createHistogram(name, {
    unit,
    description,
    ...(buckets === undefined
      ? {}
      : {advice: {explicitBucketBoundaries: [...buckets]}}),
  });
}

/** The six token histograms of one family (`invoke_agent` or `invoke_workflow`). */
export interface TokenHistograms {
  readonly input: Histogram;
  readonly output: Histogram;
  readonly total: Histogram;
  readonly cacheRead: Histogram;
  readonly reasoning: Histogram;
  readonly toolInput: Histogram;
}

/**
 * Builds the six token histograms for `prefix`, interpolating the shared token
 * meaning descriptions with `scopeDescription`.
 */
export function createTokenHistograms(
  meter: Meter,
  prefix: string,
  scopeDescription: string,
): TokenHistograms {
  const tokenHistogram = (
    suffix: string,
    meaning: string,
    buckets: readonly number[],
  ): Histogram =>
    createHistogram({
      meter,
      name: `${prefix}.${suffix}`,
      unit: '{token}',
      description: `${meaning} Summed over ${scopeDescription}.`,
      buckets,
    });

  return {
    input: tokenHistogram(
      'input_tokens',
      INPUT_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
    output: tokenHistogram(
      'output_tokens',
      OUTPUT_TOKENS_MEANING,
      OUTPUT_TOKEN_BUCKETS,
    ),
    total: tokenHistogram(
      'total_tokens',
      TOTAL_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
    cacheRead: tokenHistogram(
      'cache_read.input_tokens',
      CACHE_READ_INPUT_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
    reasoning: tokenHistogram(
      'reasoning.output_tokens',
      REASONING_OUTPUT_TOKENS_MEANING,
      OUTPUT_TOKEN_BUCKETS,
    ),
    toolInput: tokenHistogram(
      'tool.input_tokens',
      TOOL_INPUT_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
  };
}

/**
 * Records all six token histograms for a scope where at least one model call
 * reported token usage. Unreported buckets record `0`.
 */
export function recordTokenHistograms(
  histograms: TokenHistograms,
  usage: TokenUsage,
  attributes: Attributes,
): void {
  histograms.input.record(usage.input ?? 0, attributes);
  histograms.output.record(usage.output ?? 0, attributes);
  histograms.total.record(usage.totalTokenUsage(), attributes);
  histograms.cacheRead.record(usage.cacheRead ?? 0, attributes);
  histograms.reasoning.record(usage.reasoning ?? 0, attributes);
  histograms.toolInput.record(usage.toolInput ?? 0, attributes);
}
