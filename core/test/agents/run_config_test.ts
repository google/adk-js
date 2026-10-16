/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  createRunConfig,
  ServiceTier,
  StreamingMode,
} from '../../src/agents/run_config.js';
import {logger} from '../../src/utils/logger.js';

describe('StreamingMode', () => {
  it('has NONE, SSE, and BIDI values', () => {
    expect(StreamingMode.NONE).toBe('none');
    expect(StreamingMode.SSE).toBe('sse');
    expect(StreamingMode.BIDI).toBe('bidi');
  });
});

describe('ServiceTier', () => {
  it('has FLEX, STANDARD, PRIORITY, and DEFERRED values', () => {
    expect(ServiceTier.FLEX).toBe('flex');
    expect(ServiceTier.STANDARD).toBe('standard');
    expect(ServiceTier.PRIORITY).toBe('priority');
    expect(ServiceTier.DEFERRED).toBe('deferred');
  });
});

describe('createRunConfig', () => {
  it('creates a RunConfig with all default values', () => {
    const config = createRunConfig();
    expect(config.saveInputBlobsAsArtifacts).toBe(false);
    expect(config.supportCfc).toBe(false);
    expect(config.enableAffectiveDialog).toBe(false);
    expect(config.streamingMode).toBe(StreamingMode.NONE);
    expect(config.maxLlmCalls).toBe(500);
    expect(config.pauseOnToolCalls).toBe(false);
    expect(config.serviceTier).toBeUndefined();
  });

  it('overrides defaults with provided params', () => {
    const config = createRunConfig({
      saveInputBlobsAsArtifacts: true,
      supportCfc: true,
      streamingMode: StreamingMode.SSE,
      pauseOnToolCalls: true,
      serviceTier: ServiceTier.PRIORITY,
    });
    expect(config.saveInputBlobsAsArtifacts).toBe(true);
    expect(config.supportCfc).toBe(true);
    expect(config.streamingMode).toBe(StreamingMode.SSE);
    expect(config.pauseOnToolCalls).toBe(true);
    expect(config.serviceTier).toBe(ServiceTier.PRIORITY);
  });

  it('accepts ServiceTier enum and plain string values', () => {
    const deferredConfig = createRunConfig({
      serviceTier: ServiceTier.DEFERRED,
    });
    expect(deferredConfig.serviceTier).toBe('deferred');

    const stringConfig = createRunConfig({
      serviceTier: 'some_future_tier',
    });
    expect(stringConfig.serviceTier).toBe('some_future_tier');
  });

  it('throws when serviceTier is DEFERRED and streamingMode is SSE', () => {
    expect(() =>
      createRunConfig({
        serviceTier: ServiceTier.DEFERRED,
        streamingMode: StreamingMode.SSE,
      }),
    ).toThrow("serviceTier='deferred' cannot be used with StreamingMode.SSE.");

    expect(() =>
      createRunConfig({
        serviceTier: 'deferred',
        streamingMode: StreamingMode.SSE,
      }),
    ).toThrow("serviceTier='deferred' cannot be used with StreamingMode.SSE.");
  });

  it('uses provided maxLlmCalls when specified', () => {
    const config = createRunConfig({maxLlmCalls: 100});
    expect(config.maxLlmCalls).toBe(100);
  });

  it('throws when streamingMode is StreamingMode.BIDI', () => {
    expect(() => createRunConfig({streamingMode: StreamingMode.BIDI})).toThrow(
      'StreamingMode.BIDI is not supported; use StreamingMode.SSE.',
    );
  });

  it('logs a warning when maxLlmCalls is 0', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const config = createRunConfig({maxLlmCalls: 0});
    expect(config.maxLlmCalls).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('logs a warning when maxLlmCalls is negative', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const config = createRunConfig({maxLlmCalls: -1});
    expect(config.maxLlmCalls).toBe(-1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('uses the default when maxLlmCalls is explicitly undefined', () => {
    const config = createRunConfig({maxLlmCalls: undefined});
    expect(config.maxLlmCalls).toBe(500);
  });

  it('throws when maxLlmCalls exceeds Number.MAX_SAFE_INTEGER', () => {
    expect(() =>
      createRunConfig({maxLlmCalls: Number.MAX_SAFE_INTEGER + 1}),
    ).toThrow();
  });
});
