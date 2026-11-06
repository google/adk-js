/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  type BigQueryLoggerConfig,
  createBigQueryLoggerConfig,
  validateLoggerConfig,
} from '../../../src/plugins/bigquery_agent_analytics/config.js';

describe('createBigQueryLoggerConfig', () => {
  it('supplies defaults matching adk-python specifications', () => {
    const config = createBigQueryLoggerConfig();

    expect(config.enabled).toBe(true);
    expect(config.eventAllowlist).toBeUndefined();
    expect(config.eventDenylist).toBeUndefined();
    expect(config.maxContentLength).toBe(500 * 1024);
    expect(config.tableId).toBe('agent_events');
    expect(config.clusteringFields).toEqual(['event_type', 'agent', 'user_id']);
    expect(config.logMultiModalContent).toBe(true);
    expect(config.batchSize).toBe(1);
    expect(config.batchFlushInterval).toBe(1.0);
    expect(config.shutdownTimeout).toBe(10.0);
    expect(config.queueMaxSize).toBe(10000);
    expect(config.logSessionMetadata).toBe(true);
    expect(config.customTags).toEqual({});
    expect(config.flushOnRunEnd).toBe(true);
    expect(config.enableOtelCorrelation).toBe(false);

    expect(config.retryConfig).toEqual({
      maxRetries: 3,
      initialDelay: 1.0,
      multiplier: 2.0,
      maxDelay: 10.0,
    });
  });

  it('merges partial overrides with defaults', () => {
    const config = createBigQueryLoggerConfig({
      tableId: 'custom_events',
      batchSize: 50,
      retryConfig: {
        maxRetries: 5,
        initialDelay: 2.0,
        multiplier: 1.5,
        maxDelay: 20.0,
      },
    });

    expect(config.tableId).toBe('custom_events');
    expect(config.batchSize).toBe(50);
    expect(config.batchFlushInterval).toBe(1.0);
    expect(config.retryConfig.maxRetries).toBe(5);
    expect(config.retryConfig.initialDelay).toBe(2.0);
  });
});

describe('validateLoggerConfig', () => {
  it('accepts valid default configuration', () => {
    const config = createBigQueryLoggerConfig();
    expect(() => validateLoggerConfig(config)).not.toThrow();
  });

  it('accepts maxContentLength of -1 for unlimited', () => {
    const config = createBigQueryLoggerConfig({maxContentLength: -1});
    expect(() => validateLoggerConfig(config)).not.toThrow();
  });

  it.each([
    ['batchSize', {batchSize: 0}, 'batchSize must be an integer of at least 1'],
    [
      'batchSize',
      {batchSize: -5},
      'batchSize must be an integer of at least 1',
    ],
    [
      'batchSize',
      {batchSize: 1.5},
      'batchSize must be an integer of at least 1',
    ],
    [
      'batchFlushInterval',
      {batchFlushInterval: 0},
      'batchFlushInterval must be a finite number greater than 0',
    ],
    [
      'batchFlushInterval',
      {batchFlushInterval: -1},
      'batchFlushInterval must be a finite number greater than 0',
    ],
    [
      'shutdownTimeout',
      {shutdownTimeout: 0},
      'shutdownTimeout must be a finite number greater than 0',
    ],
    [
      'queueMaxSize',
      {queueMaxSize: 0},
      'queueMaxSize must be an integer of at least 1',
    ],
    [
      'maxContentLength',
      {maxContentLength: 0},
      'maxContentLength must be -1 (unlimited) or an integer of at least 1',
    ],
    [
      'maxContentLength',
      {maxContentLength: -2},
      'maxContentLength must be -1 (unlimited) or an integer of at least 1',
    ],
    [
      'retryConfig.maxRetries',
      {
        retryConfig: {
          maxRetries: -1,
          initialDelay: 1,
          multiplier: 2,
          maxDelay: 10,
        },
      },
      'retryConfig.maxRetries must be an integer of at least 0',
    ],
    [
      'retryConfig.initialDelay',
      {
        retryConfig: {
          maxRetries: 3,
          initialDelay: -0.5,
          multiplier: 2,
          maxDelay: 10,
        },
      },
      'retryConfig.initialDelay must be a finite number of at least 0',
    ],
    [
      'retryConfig.multiplier',
      {
        retryConfig: {
          maxRetries: 3,
          initialDelay: 1,
          multiplier: 0.9,
          maxDelay: 10,
        },
      },
      'retryConfig.multiplier must be a finite number of at least 1',
    ],
    [
      'retryConfig.maxDelay',
      {
        retryConfig: {
          maxRetries: 3,
          initialDelay: 5,
          multiplier: 2,
          maxDelay: 2,
        },
      },
      'retryConfig.maxDelay must be at least retryConfig.initialDelay',
    ],
  ])('rejects invalid %s', (_name, override, expectedMessage) => {
    const config: BigQueryLoggerConfig = createBigQueryLoggerConfig(
      override as Partial<BigQueryLoggerConfig>,
    );
    expect(() => validateLoggerConfig(config)).toThrow(expectedMessage);
  });
});
