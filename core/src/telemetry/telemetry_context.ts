/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-run telemetry overrides and the experimental-telemetry switches.
 *
 * Every knob resolves in the same order: the admin lock
 * `ADK_TELEMETRY_IGNORE_RUN_CONFIG`, then the per-run value from
 * {@link RunTelemetryConfig}, then the environment variable, then the default.
 *
 * This module is reachable from the browser entry point, so every environment
 * read is guarded.
 */

import {logger} from '../utils/logger.js';

import {readEnvVar} from './env.js';
import type {ContentCapturingMode} from './tracing.js';

/** Admin lock: when truthy, per-run telemetry overrides are ignored. */
const ADK_TELEMETRY_IGNORE_RUN_CONFIG = 'ADK_TELEMETRY_IGNORE_RUN_CONFIG';

/** Blanket opt-in for every experimental telemetry feature at once. */
const ADK_EXPERIMENTAL_TELEMETRY = 'ADK_EXPERIMENTAL_TELEMETRY';

/** Comma-separated list of the experimental telemetry features to enable. */
const ADK_EXPERIMENTAL_TELEMETRY_FEATURES =
  'ADK_EXPERIMENTAL_TELEMETRY_FEATURES';

/** Lowercased environment values that read as "on". */
const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(['1', 'true']);

/** The experimental telemetry features that can be enabled by name. */
const EXPERIMENTAL_TELEMETRY_FEATURES = [
  'skills',
  'workflow',
  'context_cache',
  'grounding',
  'mcp',
  'token_usage',
  'compaction',
] as const;

/** Name of one experimental telemetry feature. */
export type ExperimentalTelemetryFeature =
  (typeof EXPERIMENTAL_TELEMETRY_FEATURES)[number];

/** How many unrecognized feature names are remembered for warn-once. */
const MAX_WARNED_FEATURES = 64;

/** Unrecognized feature names already warned about, oldest first. */
const warnedFeatures: string[] = [];

/**
 * Per-run overrides for the telemetry environment variables, set through
 * `RunConfig.telemetry`.
 *
 * A field left undefined falls back to its environment variable. When
 * `ADK_TELEMETRY_IGNORE_RUN_CONFIG` is `1` or `true`, every field is ignored
 * and the environment decides.
 */
export interface RunTelemetryConfig {
  /**
   * Overrides `OTEL_SEMCONV_STABILITY_OPT_IN`. `'experimental'` selects the
   * experimental GenAI semantic conventions and `'stable'` the stable ones.
   */
  readonly genaiSemconvStabilityOptIn?: 'stable' | 'experimental';

  /** Overrides `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. */
  readonly captureMessageContent?: ContentCapturingMode;

  /** Overrides `ADK_EXPERIMENTAL_TELEMETRY`. */
  readonly adkExperimentalTelemetryOptIn?: boolean;

  /**
   * Overrides `ADK_EXPERIMENTAL_TELEMETRY_FEATURES`. Unrecognized names are
   * warned about once and dropped.
   */
  readonly experimentalFeaturesOptIn?: readonly string[];
}

function readTruthyEnvVar(name: string): boolean {
  return TRUTHY_ENV_VALUES.has(readEnvVar(name)?.trim().toLowerCase() ?? '');
}

function isExperimentalTelemetryFeature(
  name: string,
): name is ExperimentalTelemetryFeature {
  return (EXPERIMENTAL_TELEMETRY_FEATURES as readonly string[]).includes(name);
}

/**
 * Returns the recognized features in `values`, warning once per unrecognized
 * name, or undefined when none is recognized.
 */
function normalizeExperimentalFeatures(
  values: readonly string[] | undefined,
): ReadonlySet<ExperimentalTelemetryFeature> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const features = new Set<ExperimentalTelemetryFeature>();
  for (const value of values) {
    const name = value.trim().toLowerCase();
    if (!name) {
      continue;
    }
    if (isExperimentalTelemetryFeature(name)) {
      features.add(name);
      continue;
    }
    if (!warnedFeatures.includes(name)) {
      warnedFeatures.push(name);
      if (warnedFeatures.length > MAX_WARNED_FEATURES) {
        warnedFeatures.shift();
      }
      logger.warn(
        `Ignoring unrecognized experimental telemetry feature: ${name}`,
      );
    }
  }
  return features.size > 0 ? features : undefined;
}

/**
 * Returns true when `ADK_TELEMETRY_IGNORE_RUN_CONFIG` is set, so per-run
 * telemetry overrides must be ignored.
 */
export function shouldIgnoreRunTelemetryConfig(): boolean {
  return readTruthyEnvVar(ADK_TELEMETRY_IGNORE_RUN_CONFIG);
}

/**
 * Returns the per-run overrides that apply, which is none while the admin lock
 * is set.
 */
export function effectiveRunTelemetryConfig(
  overrides?: RunTelemetryConfig,
): RunTelemetryConfig | undefined {
  return shouldIgnoreRunTelemetryConfig() ? undefined : overrides;
}

/**
 * Returns whether the named experimental telemetry feature is enabled.
 *
 * Precedence: the admin lock, then `adkExperimentalTelemetryOptIn`, then
 * `experimentalFeaturesOptIn`, then `ADK_EXPERIMENTAL_TELEMETRY_FEATURES` or
 * `ADK_EXPERIMENTAL_TELEMETRY`, then off.
 */
export function isExperimentalTelemetryFeatureEnabled(
  feature: ExperimentalTelemetryFeature,
  overrides?: RunTelemetryConfig,
): boolean {
  const runOverrides = effectiveRunTelemetryConfig(overrides);
  if (runOverrides?.adkExperimentalTelemetryOptIn !== undefined) {
    return runOverrides.adkExperimentalTelemetryOptIn;
  }
  const runFeatures = normalizeExperimentalFeatures(
    runOverrides?.experimentalFeaturesOptIn,
  );
  if (runFeatures !== undefined) {
    return runFeatures.has(feature);
  }
  const envFeatures = normalizeExperimentalFeatures(
    (readEnvVar(ADK_EXPERIMENTAL_TELEMETRY_FEATURES) ?? '').split(','),
  );
  return (
    (envFeatures?.has(feature) ?? false) ||
    readTruthyEnvVar(ADK_EXPERIMENTAL_TELEMETRY)
  );
}
