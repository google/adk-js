/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

/**
 * Feature names.
 */
export enum FeatureName {
  PROGRESSIVE_SSE_STREAMING = 'PROGRESSIVE_SSE_STREAMING',
}

/**
 * Feature lifecycle stages.
 */
export enum FeatureStage {
  WIP = 'wip',
  EXPERIMENTAL = 'experimental',
  STABLE = 'stable',
}

/**
 * Feature configuration.
 */
export interface FeatureConfig {
  stage: FeatureStage;
  defaultOn: boolean;
}

// Central registry: FeatureName -> FeatureConfig
const FEATURE_REGISTRY: Record<FeatureName, FeatureConfig> = {
  [FeatureName.PROGRESSIVE_SSE_STREAMING]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: false,
  },
};

const WARNED_FEATURES = new Set<FeatureName>();
const FEATURE_OVERRIDES: Partial<Record<FeatureName, boolean>> = {};

/**
 * Get the configuration of a feature from the registry.
 *
 * @param featureName The feature name.
 * @returns The feature config from the registry, or undefined if not found.
 */
export function getFeatureConfig(
  featureName: FeatureName,
): FeatureConfig | undefined {
  return FEATURE_REGISTRY[featureName];
}

/**
 * Register a feature with a specific config.
 *
 * @param featureName The feature name.
 * @param config The feature config to register.
 */
export function registerFeature(
  featureName: FeatureName,
  config: FeatureConfig,
): void {
  FEATURE_REGISTRY[featureName] = config;
}

/**
 * Programmatically override a feature's enabled state.
 *
 * This override takes highest priority, superseding environment variables
 * and registry defaults.
 *
 * @param featureName The feature name to override.
 * @param enabled Whether the feature should be enabled.
 */
export function overrideFeatureEnabled(
  featureName: FeatureName,
  enabled: boolean | undefined,
): void {
  const config = getFeatureConfig(featureName);
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }
  if (enabled === undefined) {
    delete FEATURE_OVERRIDES[featureName];
  } else {
    FEATURE_OVERRIDES[featureName] = enabled;
  }
}

/**
 * Check if a feature is enabled at runtime.
 *
 * Priority order (highest to lowest):
 * 1. Programmatic overrides
 * 2. Environment variables (ADK_ENABLE_* / ADK_DISABLE_*)
 * 3. Registry defaults
 *
 * @param featureName The feature name.
 * @returns True if the feature is enabled, false otherwise.
 */
export function isFeatureEnabled(featureName: FeatureName): boolean {
  const config = getFeatureConfig(featureName);
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }

  // Check programmatic overrides first
  if (featureName in FEATURE_OVERRIDES) {
    const enabled = FEATURE_OVERRIDES[featureName]!;
    if (enabled && config.stage !== FeatureStage.STABLE) {
      emitNonStableWarningOnce(featureName, config.stage);
    }
    return enabled;
  }

  // Check environment variables
  const enableVar = `ADK_ENABLE_${featureName}`;
  const disableVar = `ADK_DISABLE_${featureName}`;

  if (getBooleanEnvVar(enableVar)) {
    if (config.stage !== FeatureStage.STABLE) {
      emitNonStableWarningOnce(featureName, config.stage);
    }
    return true;
  }

  if (getBooleanEnvVar(disableVar)) {
    return false;
  }

  // Fall back to registry config
  if (config.stage !== FeatureStage.STABLE && config.defaultOn) {
    emitNonStableWarningOnce(featureName, config.stage);
  }
  return config.defaultOn;
}

function emitNonStableWarningOnce(
  featureName: FeatureName,
  featureStage: FeatureStage,
): void {
  if (!WARNED_FEATURES.has(featureName)) {
    WARNED_FEATURES.add(featureName);
    logger.warn(
      `[${featureStage.toUpperCase()}] feature ${featureName} is enabled.`,
    );
  }
}

/**
 * Temporarily overrides a feature for the duration of a callback.
 */
export async function withTemporaryFeatureOverride<T>(
  featureName: FeatureName,
  enabled: boolean,
  callback: () => Promise<T> | T,
): Promise<T> {
  const config = getFeatureConfig(featureName);
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }

  const hadOverride = featureName in FEATURE_OVERRIDES;
  const originalValue = FEATURE_OVERRIDES[featureName];

  FEATURE_OVERRIDES[featureName] = enabled;

  try {
    return await callback();
  } finally {
    if (hadOverride) {
      FEATURE_OVERRIDES[featureName] = originalValue;
    } else {
      delete FEATURE_OVERRIDES[featureName];
    }
  }
}
