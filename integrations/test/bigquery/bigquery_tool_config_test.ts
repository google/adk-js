/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQueryToolConfig,
  isBigQueryToolConfig,
  WriteMode,
} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';

describe('BigQueryToolConfig and WriteMode', () => {
  it('exposes the expected string values for WriteMode', () => {
    expect(WriteMode.BLOCKED).toBe('blocked');
    expect(WriteMode.PROTECTED).toBe('protected');
    expect(WriteMode.ALLOWED).toBe('allowed');
  });

  it('initializes with default WriteMode.BLOCKED and maxQueryResultRows 50', () => {
    const config = new BigQueryToolConfig();
    expect(config.writeMode).toBe(WriteMode.BLOCKED);
    expect(config.maxQueryResultRows).toBe(50);
  });

  it('accepts a custom writeMode and maxQueryResultRows', () => {
    const protectedConfig = new BigQueryToolConfig({
      writeMode: WriteMode.PROTECTED,
      maxQueryResultRows: 25,
    });
    expect(protectedConfig.writeMode).toBe(WriteMode.PROTECTED);
    expect(protectedConfig.maxQueryResultRows).toBe(25);

    const allowedConfig = new BigQueryToolConfig({
      writeMode: WriteMode.ALLOWED,
      maxQueryResultRows: 100,
    });
    expect(allowedConfig.writeMode).toBe(WriteMode.ALLOWED);
    expect(allowedConfig.maxQueryResultRows).toBe(100);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'throws RangeError when maxQueryResultRows is %s',
    (invalidRows) => {
      expect(
        () => new BigQueryToolConfig({maxQueryResultRows: invalidRows}),
      ).toThrow(RangeError);
      expect(
        () => new BigQueryToolConfig({maxQueryResultRows: invalidRows}),
      ).toThrow('maxQueryResultRows must be a positive integer.');
    },
  );

  it('identifies BigQueryToolConfig instances via isBigQueryToolConfig', () => {
    const config = new BigQueryToolConfig();
    expect(isBigQueryToolConfig(config)).toBe(true);
    expect(isBigQueryToolConfig({writeMode: WriteMode.BLOCKED})).toBe(false);
    expect(isBigQueryToolConfig(null)).toBe(false);
    expect(isBigQueryToolConfig(undefined)).toBe(false);
    expect(isBigQueryToolConfig('config')).toBe(false);
  });
});
