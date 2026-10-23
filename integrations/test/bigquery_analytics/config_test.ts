/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  type BigQueryLoggerConfig,
  DEFAULT_LOGGER_CONFIG,
  resolveLoggerConfig,
  validateRuntimeConfig,
} from '../../src/bigquery_analytics/config.js';

function validate(overrides: Partial<BigQueryLoggerConfig>): void {
  validateRuntimeConfig(resolveLoggerConfig(overrides));
}

const RETRY = DEFAULT_LOGGER_CONFIG.retryConfig;

describe('validateRuntimeConfig', () => {
  it('accepts the defaults and unlimited content', () => {
    expect(() => validate({})).not.toThrow();
    expect(() => validate({maxContentLength: -1})).not.toThrow();
    expect(() =>
      validate({
        onSchemaError: () => undefined,
        onSchemaReady: () => undefined,
      }),
    ).not.toThrow();
  });

  it.each<[string, Partial<BigQueryLoggerConfig>, string]>([
    ['fractional batchSize', {batchSize: 1.5}, 'batchSize must be an int'],
    ['zero batchSize', {batchSize: 0}, 'batchSize must be >= 1'],
    [
      'infinite flush interval',
      {batchFlushInterval: Infinity},
      'batchFlushInterval must be finite',
    ],
    [
      'zero shutdown timeout',
      {shutdownTimeout: 0},
      'shutdownTimeout must be > 0',
    ],
    ['zero queue size', {queueMaxSize: 0}, 'queueMaxSize must be >= 1'],
    [
      'fractional content length',
      {maxContentLength: 2.5},
      'maxContentLength must be an int',
    ],
    [
      'zero content length',
      {maxContentLength: 0},
      'maxContentLength must be -1 (unlimited) or >= 1',
    ],
    [
      'negative retries',
      {retryConfig: {...RETRY, maxRetries: -1}},
      'retryConfig.maxRetries must be >= 0',
    ],
    [
      'negative initial delay',
      {retryConfig: {...RETRY, initialDelay: -0.5}},
      'retryConfig.initialDelay must be >= 0',
    ],
    [
      'shrinking multiplier',
      {retryConfig: {...RETRY, multiplier: 0.5}},
      'retryConfig.multiplier must be >= 1',
    ],
    [
      'negative max delay',
      {retryConfig: {...RETRY, maxDelay: -0.5}},
      'retryConfig.maxDelay must be >= 0',
    ],
    [
      'max delay below initial delay',
      {retryConfig: {...RETRY, initialDelay: 5, maxDelay: 1}},
      'retryConfig.maxDelay must be >= initialDelay',
    ],
    [
      'async schema callback',
      {onSchemaReady: async () => undefined},
      'onSchemaReady must be a synchronous function or null',
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => validate(overrides)).toThrow(RangeError);
    expect(() => validate(overrides)).toThrow(message);
  });
});
