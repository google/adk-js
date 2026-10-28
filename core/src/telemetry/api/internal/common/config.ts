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
const IGNORE_RUN_CONFIG_ENV = 'ADK_TELEMETRY_IGNORE_RUN_CONFIG';

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

/**
 * Per-run telemetry overrides, set through `RunConfig.telemetry`.
 *
 * A field left unset falls back to the environment variable it overrides.
 * When `ADK_TELEMETRY_IGNORE_RUN_CONFIG` is `true` or `1`, every field is
 * ignored and the environment decides.
 */
export interface TelemetryConfig {
  /** Overrides `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. */
  readonly captureMessageContent?: ContentCapturingMode;
  /**
   * Overrides `ADK_EXPERIMENTAL_TELEMETRY`. `true` enables every experimental
   * feature for the run, and `false` disables every one, including those named
   * in `ADK_EXPERIMENTAL_TELEMETRY_FEATURES` or `experimentalFeaturesOptIn`.
   */
  readonly adkExperimentalTelemetryOptIn?: boolean;
  /**
   * Overrides `ADK_EXPERIMENTAL_TELEMETRY_FEATURES`: exactly these features
   * are enabled for the run. Unrecognized names are ignored, and a list with
   * no recognized name falls back to the environment.
   */
  readonly experimentalFeaturesOptIn?: readonly ExperimentalFeature[];
}

/** The telemetry decisions for one scope. */
export interface ResolvedTelemetryConfig {
  /** Where message content is recorded. */
  readonly contentCapturingMode: ContentCapturingMode;
  /** Whether every experimental feature is enabled. */
  readonly experimentalTelemetry: boolean;
  /** Features enabled one by one. */
  readonly experimentalFeatures: ReadonlySet<ExperimentalFeature>;
}

const warnedFeatures = new Set<string>();

/** Reads an environment variable, where the platform has an environment. */
export function readEnv(name: string): string | undefined {
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

/** Whether an environment variable is `true` or `1`, ignoring case and spaces. */
export function isTruthyEnv(name: string): boolean {
  return TRUTHY_ENV_VALUES.has((readEnv(name) ?? '').trim().toLowerCase());
}

/**
 * Returns the recognized features in `names`, warning once for each name that
 * is not one.
 */
function normalizeExperimentalFeatures(
  names: Iterable<string>,
): ReadonlySet<ExperimentalFeature> {
  const features = new Set<ExperimentalFeature>();
  for (const name of names) {
    const feature = name.trim().toLowerCase();
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
 * Resolves the telemetry configuration of one scope.
 *
 * Each value comes from `overrides` when it sets it, else from its environment
 * variable, else from its default. `ADK_TELEMETRY_IGNORE_RUN_CONFIG` makes the
 * environment win over every override. The environment is read on each call
 * rather than at import, so a change to it applies to the next scope.
 */
export function resolveTelemetryConfig(
  overrides?: TelemetryConfig,
): ResolvedTelemetryConfig {
  const env: ResolvedTelemetryConfig = {
    contentCapturingMode: readContentCapturingMode(),
    experimentalTelemetry: isTruthyEnv(EXPERIMENTAL_TELEMETRY_ENV),
    experimentalFeatures: normalizeExperimentalFeatures(
      (readEnv(EXPERIMENTAL_TELEMETRY_FEATURES_ENV) ?? '').split(','),
    ),
  };
  if (overrides === undefined || isTruthyEnv(IGNORE_RUN_CONFIG_ENV)) {
    return env;
  }
  const contentCapturingMode =
    overrides.captureMessageContent ?? env.contentCapturingMode;
  if (overrides.adkExperimentalTelemetryOptIn !== undefined) {
    return {
      contentCapturingMode,
      experimentalTelemetry: overrides.adkExperimentalTelemetryOptIn,
      experimentalFeatures: new Set(),
    };
  }
  const features = normalizeExperimentalFeatures(
    overrides.experimentalFeaturesOptIn ?? [],
  );
  if (features.size > 0) {
    return {
      contentCapturingMode,
      experimentalTelemetry: false,
      experimentalFeatures: features,
    };
  }
  return {...env, contentCapturingMode};
}

/** Whether message content goes on log records (`EVENT_ONLY`, `SPAN_AND_EVENT`). */
export function shouldAddContentToLogs(
  config: ResolvedTelemetryConfig,
): boolean {
  return (
    config.contentCapturingMode === 'EVENT_ONLY' ||
    config.contentCapturingMode === 'SPAN_AND_EVENT'
  );
}

/** Whether message content goes on spans (`SPAN_ONLY`, `SPAN_AND_EVENT`). */
export function shouldAddContentToSpans(
  config: ResolvedTelemetryConfig,
): boolean {
  return (
    config.contentCapturingMode === 'SPAN_ONLY' ||
    config.contentCapturingMode === 'SPAN_AND_EVENT'
  );
}

/** Whether the named experimental feature is enabled. */
export function isExperimentalFeatureEnabled(
  config: ResolvedTelemetryConfig,
  feature: ExperimentalFeature,
): boolean {
  return (
    config.experimentalTelemetry || config.experimentalFeatures.has(feature)
  );
}
