/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  metrics,
  type Attributes,
  type Histogram,
  type Meter,
  type MeterProvider,
} from '@opentelemetry/api';

import {version} from '../../../../version.js';
import {GEN_AI_SYSTEM_VALUE, SCHEMA_URL} from '../common/attributes.js';
import {
  CACHE_READ_INPUT_TOKENS_MEANING,
  INPUT_TOKENS_MEANING,
  OUTPUT_TOKENS_MEANING,
  REASONING_OUTPUT_TOKENS_MEANING,
  TOOL_INPUT_TOKENS_MEANING,
  TOTAL_TOKENS_MEANING,
  type TokenUsage,
} from '../common/token_usage.js';

/**
 * Bucket bounds for call-count histograms.
 *
 * Bounds are upper inclusive, so the leading 0 buckets exact zeros on their
 * own. The tail is sized for a workflow, which sums every agent that ran in it.
 */
export const CALL_COUNT_BUCKETS: readonly number[] = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64, 128, 256, 512,
]);

/** Bucket bounds for input-side token histograms. */
export const INPUT_TOKEN_BUCKETS: readonly number[] = Object.freeze([
  0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144,
  524288, 1048576,
]);

/** Bucket bounds for output-side token histograms. */
export const OUTPUT_TOKEN_BUCKETS: readonly number[] = Object.freeze([
  0, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072,
]);

/**
 * Returns a getter for one domain's instruments, built once per registered
 * `MeterProvider`.
 *
 * `@opentelemetry/api` has no proxy meter provider: a meter taken before the
 * application registers its provider stays a no-op forever. The instruments
 * are therefore resolved against the global provider on every call, and cached
 * per provider so they are not created again on each record.
 */
export function cachedInstruments<T>(create: (meter: Meter) => T): () => T {
  const cache = new WeakMap<MeterProvider, T>();
  return () => {
    const provider = metrics.getMeterProvider();
    const cached = cache.get(provider);
    if (cached !== undefined) {
      return cached;
    }
    const instruments = create(
      provider.getMeter(GEN_AI_SYSTEM_VALUE, version, {schemaUrl: SCHEMA_URL}),
    );
    cache.set(provider, instruments);
    return instruments;
  };
}

/** Parameters for {@link createHistogram}. */
export interface CreateHistogramParams {
  readonly name: string;
  readonly unit: string;
  readonly description: string;
  /** Advisory bucket boundaries; the SDK default applies when omitted. */
  readonly buckets?: readonly number[];
}

/** Creates a histogram with optional advisory bucket boundaries. */
export function createHistogram(
  meter: Meter,
  {name, unit, description, buckets}: CreateHistogramParams,
): Histogram {
  return meter.createHistogram(name, {
    unit,
    description,
    ...(buckets ? {advice: {explicitBucketBoundaries: [...buckets]}} : {}),
  });
}

/** The six token histograms of one family, such as `invoke_agent`. */
export interface TokenHistograms {
  readonly input: Histogram;
  readonly output: Histogram;
  readonly total: Histogram;
  readonly cacheRead: Histogram;
  readonly reasoning: Histogram;
  readonly toolInput: Histogram;
}

/**
 * Creates the token histograms named `{prefix}.input_tokens` and so on.
 *
 * @param per What one datapoint covers, spelled into each description.
 */
export function createTokenHistograms(
  meter: Meter,
  prefix: string,
  per: string,
): TokenHistograms {
  const create = (
    suffix: string,
    meaning: string,
    buckets: readonly number[],
  ): Histogram =>
    createHistogram(meter, {
      name: `${prefix}.${suffix}`,
      unit: '{token}',
      description: `${meaning} Summed over ${per}.`,
      buckets,
    });
  return {
    input: create('input_tokens', INPUT_TOKENS_MEANING, INPUT_TOKEN_BUCKETS),
    output: create(
      'output_tokens',
      OUTPUT_TOKENS_MEANING,
      OUTPUT_TOKEN_BUCKETS,
    ),
    total: create('total_tokens', TOTAL_TOKENS_MEANING, INPUT_TOKEN_BUCKETS),
    cacheRead: create(
      'cache_read.input_tokens',
      CACHE_READ_INPUT_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
    reasoning: create(
      'reasoning.output_tokens',
      REASONING_OUTPUT_TOKENS_MEANING,
      OUTPUT_TOKEN_BUCKETS,
    ),
    toolInput: create(
      'tool.input_tokens',
      TOOL_INPUT_TOKENS_MEANING,
      INPUT_TOKEN_BUCKETS,
    ),
  };
}

/**
 * Records accumulated token usage on a token histogram family. A bucket no
 * call reported records 0.
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
