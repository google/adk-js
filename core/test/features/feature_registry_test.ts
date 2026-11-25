/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  FeatureStage,
  getFeatureConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
  registerFeature,
  withTemporaryFeatureOverride,
  type Logger,
} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

describe('FeatureRegistry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {...originalEnv};
    delete process.env.ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS;
    // Reset overrides
    // We can't easily reset the internal modules without exposing a reset function,
    // but we can override back to undefined or known state using overrideFeatureEnabled
    // Actually withTemporaryFeatureOverride does clean up.
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should get correct config for PROGRESSIVE_SSE_STREAMING', () => {
    const config = getFeatureConfig(FeatureName.PROGRESSIVE_SSE_STREAMING);
    expect(config).toBeDefined();
    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(false);
  });

  it('should return defaultOn value when no overrides or env vars', () => {
    delete process.env.ADK_ENABLE_PROGRESSIVE_SSE_STREAMING;
    delete process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING;

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);
  });

  it('should respect ADK_DISABLE_ env var', () => {
    process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING = 'true';

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);
  });

  it('should respect ADK_ENABLE_ env var', () => {
    // Register a dummy feature that is default off
    const dummyName = 'DUMMY_FEATURE' as FeatureName;
    registerFeature(dummyName, {
      stage: FeatureStage.EXPERIMENTAL,
      defaultOn: false,
    });

    process.env.ADK_ENABLE_DUMMY_FEATURE = 'true';

    expect(isFeatureEnabled(dummyName)).toBe(true);
  });

  it('should respect programmatic overrides over env vars', () => {
    process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING = 'true';
    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, true);

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);

    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, undefined);
  });

  it('should throw error when checking unregistered feature', () => {
    expect(() => isFeatureEnabled('NON_EXISTENT' as FeatureName)).toThrowError(
      /is not registered/,
    );
  });

  it('should support temporary overrides', async () => {
    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);

    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      true,
      () => {
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          true,
        );
      },
    );

    // restored
    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);
  });

  it('should support temporary overrides with promises', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      true,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          true,
        );
      },
    );
  });

  describe('warning suppression and flexible env flags', () => {
    let warnSpy: MockInstance<Logger['warn']>;
    let isolatedRegistry: typeof import('../../src/features/feature_registry.js');

    beforeEach(async () => {
      const cleanEnv = {...originalEnv};
      delete cleanEnv['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'];
      delete cleanEnv['ADK_ENABLE_COMPUTER_USE'];
      delete cleanEnv['ADK_DISABLE_COMPUTER_USE'];
      delete cleanEnv['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING'];
      delete cleanEnv['ADK_DISABLE_PROGRESSIVE_SSE_STREAMING'];
      process.env = cleanEnv;

      vi.resetModules();
      const {logger} = await import('../../src/utils/logger.js');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      isolatedRegistry = await import('../../src/features/feature_registry.js');
    });

    it('suppresses defaultOn experimental warnings when ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS is truthy and warns once cleared', () => {
      for (const value of [
        '1',
        'true',
        'True',
        'TRUE',
        'yes',
        'YES',
        'on',
        'ON',
        ' true ',
      ]) {
        process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'] = value;
        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.COMPUTER_USE,
          ),
        ).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      }

      delete process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'];
      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.COMPUTER_USE,
        ),
      ).toBe(true);
      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.COMPUTER_USE,
        ),
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature COMPUTER_USE is enabled.',
      );
    });

    it('suppresses experimental warnings when enabled via ADK_ENABLE_* or programmatic override and warns once cleared', () => {
      process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'] = 'on';
      process.env['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING'] = 'yes';
      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        ),
      ).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();

      delete process.env['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING'];
      isolatedRegistry.overrideFeatureEnabled(
        isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        true,
      );
      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        ),
      ).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();

      delete process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'];
      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        ),
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature PROGRESSIVE_SSE_STREAMING is enabled.',
      );
    });

    it('does not suppress FeatureStage.WIP warnings when ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS is enabled', () => {
      isolatedRegistry.registerFeature(
        isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        {
          stage: isolatedRegistry.FeatureStage.WIP,
          defaultOn: true,
        },
      );
      process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'] = 'true';

      expect(
        isolatedRegistry.isFeatureEnabled(
          isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
        ),
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        '[WIP] feature PROGRESSIVE_SSE_STREAMING is enabled.',
      );
    });

    it.each(['0', 'false', 'False', 'FALSE', 'no', 'off', ''])(
      'still warns for experimental features when ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS is %j',
      (falsyValue) => {
        process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'] = falsyValue;

        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.COMPUTER_USE,
          ),
        ).toBe(true);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(
          '[EXPERIMENTAL] feature COMPUTER_USE is enabled.',
        );
      },
    );

    it('accepts yes, on, and whitespace-padded values for ADK_ENABLE_* and ADK_DISABLE_*', () => {
      process.env['ADK_SUPPRESS_EXPERIMENTAL_FEATURE_WARNINGS'] = '1';

      for (const truthyValue of ['1', 'true', 'yes', 'on', ' yes ']) {
        process.env['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING'] = truthyValue;
        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
          ),
        ).toBe(true);
      }

      for (const falsyValue of ['0', 'false', 'no', 'off', '']) {
        process.env['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING'] = falsyValue;
        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.PROGRESSIVE_SSE_STREAMING,
          ),
        ).toBe(false);
      }

      for (const truthyValue of ['1', 'true', 'yes', 'on', ' on ']) {
        process.env['ADK_DISABLE_COMPUTER_USE'] = truthyValue;
        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.COMPUTER_USE,
          ),
        ).toBe(false);
      }
      expect(warnSpy).not.toHaveBeenCalled();

      for (const falsyValue of ['0', 'false', 'no', 'off', '']) {
        process.env['ADK_DISABLE_COMPUTER_USE'] = falsyValue;
        expect(
          isolatedRegistry.isFeatureEnabled(
            isolatedRegistry.FeatureName.COMPUTER_USE,
          ),
        ).toBe(true);
      }
    });
  });
});
