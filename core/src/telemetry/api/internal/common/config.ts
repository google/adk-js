/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../../../utils/logger.js';

const CAPTURE_MESSAGE_CONTENT_ENV =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const EXPERIMENTAL_TELEMETRY_ENV = 'ADK_EXPERIMENTAL_TELEMETRY';
const EXPERIMENTAL_TELEMETRY_FEATURES_ENV =
  'ADK_EXPERIMENTAL_TELEMETRY_FEATURES';

const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

/**
 * Where GenAI message content is recorded, as named by
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export type ContentCapturingMode =
  'NO_CONTENT' | 'EVENT_ONLY' | 'SPAN_ONLY' | 'SPAN_AND_EVENT';

const CONTENT_CAPTURING_MODES: ReadonlySet<string> =
  new Set<ContentCapturingMode>([
    'NO_CONTENT',
    'EVENT_ONLY',
    'SPAN_ONLY',
    'SPAN_AND_EVENT',
  ]);

/** A named group of experimental telemetry that can be enabled on its own. */
export type ExperimentalFeature =
  | 'skills'
  | 'workflow'
  | 'context_cache'
  | 'grounding'
  | 'mcp'
  | 'token_usage'
  | 'compaction';

const EXPERIMENTAL_FEATURES: ReadonlySet<string> = new Set<ExperimentalFeature>(
  [
    'skills',
    'workflow',
    'context_cache',
    'grounding',
    'mcp',
    'token_usage',
    'compaction',
  ],
);

/** The telemetry decisions for one scope, resolved from the environment. */
export interface TelemetryConfig {
  /** Where message content is recorded. */
  readonly contentCapturingMode: ContentCapturingMode;
  /** Whether `ADK_EXPERIMENTAL_TELEMETRY` enables every experimental feature. */
  readonly experimentalTelemetry: boolean;
  /** Features enabled one by one through `ADK_EXPERIMENTAL_TELEMETRY_FEATURES`. */
  readonly experimentalFeatures: ReadonlySet<ExperimentalFeature>;
}

const warnedFeatures = new Set<string>();

function readEnv(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.[name];
}

function isExperimentalFeature(value: string): value is ExperimentalFeature {
  return EXPERIMENTAL_FEATURES.has(value);
}

function isContentCapturingMode(value: string): value is ContentCapturingMode {
  return CONTENT_CAPTURING_MODES.has(value);
}

function readContentCapturingMode(): ContentCapturingMode {
  const value = (readEnv(CAPTURE_MESSAGE_CONTENT_ENV) ?? '').trim();
  // The variable used to be a boolean; a truthy value keeps meaning "content
  // on the log record".
  if (TRUTHY_ENV_VALUES.has(value.toLowerCase())) {
    return 'EVENT_ONLY';
  }
  const mode = value.toUpperCase();
  return isContentCapturingMode(mode) ? mode : 'NO_CONTENT';
}

function readExperimentalFeatures(): ReadonlySet<ExperimentalFeature> {
  const features = new Set<ExperimentalFeature>();
  for (const entry of (
    readEnv(EXPERIMENTAL_TELEMETRY_FEATURES_ENV) ?? ''
  ).split(',')) {
    const feature = entry.trim().toLowerCase();
    if (!feature) {
      continue;
    }
    if (isExperimentalFeature(feature)) {
      features.add(feature);
    } else if (!warnedFeatures.has(feature)) {
      warnedFeatures.add(feature);
      logger.warn(
        `Ignoring unrecognized experimental telemetry feature: ${feature}`,
      );
    }
  }
  return features;
}

/**
 * Resolves the telemetry configuration from the environment.
 *
 * Read when a scope starts rather than at import, so a change to the
 * environment applies to the next scope.
 */
export function readTelemetryConfig(): TelemetryConfig {
  return {
    contentCapturingMode: readContentCapturingMode(),
    experimentalTelemetry: TRUTHY_ENV_VALUES.has(
      (readEnv(EXPERIMENTAL_TELEMETRY_ENV) ?? 'false').trim().toLowerCase(),
    ),
    experimentalFeatures: readExperimentalFeatures(),
  };
}

/** Whether message content goes on log records (`EVENT_ONLY`, `SPAN_AND_EVENT`). */
export function shouldAddContentToLogs(config: TelemetryConfig): boolean {
  return (
    config.contentCapturingMode === 'EVENT_ONLY' ||
    config.contentCapturingMode === 'SPAN_AND_EVENT'
  );
}

/** Whether message content goes on spans (`SPAN_ONLY`, `SPAN_AND_EVENT`). */
export function shouldAddContentToSpans(config: TelemetryConfig): boolean {
  return (
    config.contentCapturingMode === 'SPAN_ONLY' ||
    config.contentCapturingMode === 'SPAN_AND_EVENT'
  );
}

/** Whether the named experimental feature is enabled. */
export function isExperimentalFeatureEnabled(
  config: TelemetryConfig,
  feature: ExperimentalFeature,
): boolean {
  return (
    config.experimentalTelemetry || config.experimentalFeatures.has(feature)
  );
}
