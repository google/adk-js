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
    expect(WriteMode.ALLOWED).toBe('allowed');
  });

  it('initializes with default WriteMode.BLOCKED', () => {
    const config = new BigQueryToolConfig();
    expect(config.writeMode).toBe(WriteMode.BLOCKED);
  });

  it('accepts a custom writeMode', () => {
    const allowedConfig = new BigQueryToolConfig({
      writeMode: WriteMode.ALLOWED,
    });
    expect(allowedConfig.writeMode).toBe(WriteMode.ALLOWED);
  });

  it('identifies BigQueryToolConfig instances via isBigQueryToolConfig', () => {
    const config = new BigQueryToolConfig();
    expect(isBigQueryToolConfig(config)).toBe(true);
    expect(isBigQueryToolConfig({writeMode: WriteMode.BLOCKED})).toBe(false);
    expect(isBigQueryToolConfig(null)).toBe(false);
    expect(isBigQueryToolConfig(undefined)).toBe(false);
    expect(isBigQueryToolConfig('config')).toBe(false);
  });
});
