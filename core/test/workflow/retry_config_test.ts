/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The retry helpers are internal, so this suite imports them relatively.
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  getRetryDelayMs,
  shouldRetryNode,
} from '../../src/workflow/retry_config.js';

/** An error class that never assigns `this.name`, so `name` stays 'Error'. */
class UnnamedError extends Error {}

class NamedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamedError';
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldRetryNode', () => {
  it('never retries without a retry config', () => {
    expect(shouldRetryNode(new Error('boom'), undefined, 1)).toBe(false);
  });

  it('retries any error when no error filter is given', () => {
    expect(shouldRetryNode(new TypeError('boom'), {}, 1)).toBe(true);
  });

  it('stops once the attempt count reaches maxAttempts', () => {
    expect(shouldRetryNode(new Error('boom'), {maxAttempts: 3}, 2)).toBe(true);
    expect(shouldRetryNode(new Error('boom'), {maxAttempts: 3}, 3)).toBe(false);
  });

  it('defaults maxAttempts to 5', () => {
    expect(shouldRetryNode(new Error('boom'), {}, 4)).toBe(true);
    expect(shouldRetryNode(new Error('boom'), {}, 5)).toBe(false);
  });

  it('matches an error by name', () => {
    const config = {errors: ['NamedError']};

    expect(shouldRetryNode(new NamedError('boom'), config, 1)).toBe(true);
    expect(shouldRetryNode(new TypeError('boom'), config, 1)).toBe(false);
  });

  it('matches an error by class', () => {
    expect(
      shouldRetryNode(new TypeError('boom'), {errors: [TypeError]}, 1),
    ).toBe(true);
  });

  it('matches a class that never sets this.name, by constructor name', () => {
    const failure = new UnnamedError('boom');

    expect(failure.name).toBe('Error');
    expect(shouldRetryNode(failure, {errors: [UnnamedError]}, 1)).toBe(true);
    expect(shouldRetryNode(failure, {errors: ['UnnamedError']}, 1)).toBe(true);
  });

  it('accepts a mix of names and classes', () => {
    const config = {errors: ['NamedError', TypeError]};

    expect(shouldRetryNode(new NamedError('boom'), config, 1)).toBe(true);
    expect(shouldRetryNode(new TypeError('boom'), config, 1)).toBe(true);
    expect(shouldRetryNode(new RangeError('boom'), config, 1)).toBe(false);
  });

  it('does not match a thrown value that is not an Error', () => {
    expect(shouldRetryNode('boom', {errors: ['String']}, 1)).toBe(false);
    expect(shouldRetryNode('boom', {}, 1)).toBe(true);
  });
});

describe('getRetryDelayMs', () => {
  it('grows exponentially from the initial delay', () => {
    const config = {jitter: 0};

    expect(getRetryDelayMs(config, 1)).toBe(1000);
    expect(getRetryDelayMs(config, 2)).toBe(2000);
    expect(getRetryDelayMs(config, 3)).toBe(4000);
  });

  it('honours a custom initial delay and backoff factor', () => {
    const config = {initialDelayMs: 50, backoffFactor: 3, jitter: 0};

    expect(getRetryDelayMs(config, 1)).toBe(50);
    expect(getRetryDelayMs(config, 2)).toBe(150);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(getRetryDelayMs({jitter: 0, maxDelayMs: 2500}, 5)).toBe(2500);
    expect(getRetryDelayMs({jitter: 0}, 20)).toBe(60_000);
  });

  it('treats an attempt count below one as the first attempt', () => {
    expect(getRetryDelayMs({jitter: 0}, 0)).toBe(1000);
  });

  it('offsets the delay by the jitter fraction', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    // random() === 1 puts the offset at +jitter * delay.
    expect(getRetryDelayMs({jitter: 0.5}, 1)).toBe(1500);
  });

  it('never returns a negative delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // random() === 0 puts the offset at -jitter * delay, twice the delay here.
    expect(getRetryDelayMs({jitter: 2}, 1)).toBe(0);
  });

  it('applies the default jitter of one', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    expect(getRetryDelayMs({}, 1)).toBe(2000);
  });
});
