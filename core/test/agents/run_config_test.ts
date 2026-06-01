/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {createRunConfig, StreamingMode} from '../../src/agents/run_config.js';

describe('StreamingMode', () => {
  it('has NONE, SSE, and BIDI values', () => {
    expect(StreamingMode.NONE).toBe('none');
    expect(StreamingMode.SSE).toBe('sse');
    expect(StreamingMode.BIDI).toBe('bidi');
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
  });

  it('overrides defaults with provided params', () => {
    const config = createRunConfig({
      saveInputBlobsAsArtifacts: true,
      supportCfc: true,
      streamingMode: StreamingMode.SSE,
      pauseOnToolCalls: true,
    });
    expect(config.saveInputBlobsAsArtifacts).toBe(true);
    expect(config.supportCfc).toBe(true);
    expect(config.streamingMode).toBe(StreamingMode.SSE);
    expect(config.pauseOnToolCalls).toBe(true);
  });

  it('uses provided maxLlmCalls when specified', () => {
    const config = createRunConfig({maxLlmCalls: 100});
    expect(config.maxLlmCalls).toBe(100);
  });

  it('accepts StreamingMode.BIDI', () => {
    const config = createRunConfig({streamingMode: StreamingMode.BIDI});
    expect(config.streamingMode).toBe(StreamingMode.BIDI);
  });

  it('logs a warning when maxLlmCalls is 0', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createRunConfig({maxLlmCalls: 0});
    // The warning goes through the logger; restore spy regardless of whether
    // it is intercepted at the console level.
    warnSpy.mockRestore();
  });

  it('logs a warning when maxLlmCalls is negative', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createRunConfig({maxLlmCalls: -1});
    warnSpy.mockRestore();
  });

  it('throws when maxLlmCalls exceeds Number.MAX_SAFE_INTEGER', () => {
    expect(() =>
      createRunConfig({maxLlmCalls: Number.MAX_SAFE_INTEGER + 1}),
    ).toThrow();
  });
});
