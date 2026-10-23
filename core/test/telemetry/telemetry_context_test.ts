/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ContentCapturingMode} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  isExperimentalTelemetryFeatureEnabled,
  shouldIgnoreRunTelemetryConfig,
} from '../../src/telemetry/telemetry_context.js';
import {getTelemetryConfig} from '../../src/telemetry/tracing.js';
import {logger} from '../../src/utils/logger.js';

const TELEMETRY_ENV_VARS = [
  'ADK_TELEMETRY_IGNORE_RUN_CONFIG',
  'ADK_EXPERIMENTAL_TELEMETRY',
  'ADK_EXPERIMENTAL_TELEMETRY_FEATURES',
  'ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN',
  'OTEL_SEMCONV_STABILITY_OPT_IN',
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
];

describe('telemetry_context', () => {
  beforeEach(() => {
    for (const name of TELEMETRY_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('per-run overrides beat their environment variable', () => {
    it('genaiSemconvStabilityOptIn stable beats the v2 schema default', () => {
      expect(getTelemetryConfig().shouldUseExperimentalGenAiSemconv).toBe(true);
      expect(
        getTelemetryConfig({genaiSemconvStabilityOptIn: 'stable'})
          .shouldUseExperimentalGenAiSemconv,
      ).toBe(false);
    });

    it('genaiSemconvStabilityOptIn experimental beats the v1 schema', () => {
      vi.stubEnv('ADK_TELEMETRY_SCHEMA_VERSION_OPT_IN', '1');

      expect(getTelemetryConfig().shouldUseExperimentalGenAiSemconv).toBe(
        false,
      );
      const config = getTelemetryConfig({
        genaiSemconvStabilityOptIn: 'experimental',
      });
      expect(config.shouldUseExperimentalGenAiSemconv).toBe(true);
      expect(config.schemaVersion).toBe(1);
    });

    it('captureMessageContent beats OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', () => {
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true');

      expect(getTelemetryConfig().shouldAddContentToLogs).toBe(true);
      const config = getTelemetryConfig({
        captureMessageContent: ContentCapturingMode.NO_CONTENT,
      });
      expect(config.captureMessageContent).toBe(
        ContentCapturingMode.NO_CONTENT,
      );
      expect(config.shouldAddContentToLogs).toBe(false);
    });

    it('adkExperimentalTelemetryOptIn beats ADK_EXPERIMENTAL_TELEMETRY', () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');

      expect(isExperimentalTelemetryFeatureEnabled('mcp')).toBe(true);
      expect(
        isExperimentalTelemetryFeatureEnabled('mcp', {
          adkExperimentalTelemetryOptIn: false,
        }),
      ).toBe(false);
    });

    it('experimentalFeaturesOptIn beats ADK_EXPERIMENTAL_TELEMETRY_FEATURES', () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'mcp');

      expect(isExperimentalTelemetryFeatureEnabled('mcp')).toBe(true);
      expect(
        isExperimentalTelemetryFeatureEnabled('mcp', {
          experimentalFeaturesOptIn: ['skills'],
        }),
      ).toBe(false);
      expect(
        isExperimentalTelemetryFeatureEnabled('skills', {
          experimentalFeaturesOptIn: ['skills'],
        }),
      ).toBe(true);
    });
  });

  describe('ADK_TELEMETRY_IGNORE_RUN_CONFIG', () => {
    beforeEach(() => {
      vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', 'true');
    });

    it('reads as set for 1 and true only', () => {
      expect(shouldIgnoreRunTelemetryConfig()).toBe(true);
      vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', ' 1 ');
      expect(shouldIgnoreRunTelemetryConfig()).toBe(true);
      vi.stubEnv('ADK_TELEMETRY_IGNORE_RUN_CONFIG', 'yes');
      expect(shouldIgnoreRunTelemetryConfig()).toBe(false);
    });

    it('ignores genaiSemconvStabilityOptIn', () => {
      expect(
        getTelemetryConfig({genaiSemconvStabilityOptIn: 'stable'})
          .shouldUseExperimentalGenAiSemconv,
      ).toBe(true);
    });

    it('ignores captureMessageContent', () => {
      expect(
        getTelemetryConfig({
          captureMessageContent: ContentCapturingMode.EVENT_ONLY,
        }).captureMessageContent,
      ).toBe(ContentCapturingMode.NO_CONTENT);
    });

    it('ignores adkExperimentalTelemetryOptIn', () => {
      expect(
        isExperimentalTelemetryFeatureEnabled('mcp', {
          adkExperimentalTelemetryOptIn: true,
        }),
      ).toBe(false);
    });

    it('ignores experimentalFeaturesOptIn', () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'mcp');

      expect(
        isExperimentalTelemetryFeatureEnabled('mcp', {
          experimentalFeaturesOptIn: ['skills'],
        }),
      ).toBe(true);
    });
  });

  describe('isExperimentalTelemetryFeatureEnabled', () => {
    it('is off by default', () => {
      expect(isExperimentalTelemetryFeatureEnabled('mcp')).toBe(false);
    });

    it.each(['true', '1', ' TRUE '])(
      'is on for ADK_EXPERIMENTAL_TELEMETRY=%s',
      (value) => {
        vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', value);

        expect(isExperimentalTelemetryFeatureEnabled('mcp')).toBe(true);
      },
    );

    it('is on for a feature named in ADK_EXPERIMENTAL_TELEMETRY_FEATURES', () => {
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY_FEATURES', 'skills, MCP');

      expect(isExperimentalTelemetryFeatureEnabled('mcp')).toBe(true);
      expect(isExperimentalTelemetryFeatureEnabled('workflow')).toBe(false);
    });

    it('lets the per-run blanket opt-in beat the per-run feature list', () => {
      expect(
        isExperimentalTelemetryFeatureEnabled('mcp', {
          adkExperimentalTelemetryOptIn: true,
          experimentalFeaturesOptIn: ['skills'],
        }),
      ).toBe(true);
    });

    it('warns once per unknown feature and falls back to env when none is known', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.stubEnv('ADK_EXPERIMENTAL_TELEMETRY', 'true');
      const overrides = {experimentalFeaturesOptIn: ['not-a-feature-1']};

      expect(isExperimentalTelemetryFeatureEnabled('mcp', overrides)).toBe(
        true,
      );
      expect(isExperimentalTelemetryFeatureEnabled('mcp', overrides)).toBe(
        true,
      );

      const warnings = warn.mock.calls.filter(([message]) =>
        String(message).includes('not-a-feature-1'),
      );
      expect(warnings).toHaveLength(1);
    });
  });

  it('keeps getTelemetryConfig() without overrides on the environment', () => {
    vi.stubEnv(
      'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
      'SPAN_ONLY',
    );

    expect(getTelemetryConfig()).toEqual({
      schemaVersion: 2,
      shouldUseExperimentalGenAiSemconv: true,
      captureMessageContent: ContentCapturingMode.SPAN_ONLY,
      shouldAddContentToLogs: false,
      shouldAddContentToExperimentalSpans: true,
    });
  });
});
