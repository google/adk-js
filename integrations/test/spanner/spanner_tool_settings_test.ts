/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSpannerToolSettings,
  resolveMaxExecutedQueryResultRows,
  SpannerCapabilities,
  SpannerToolSettings,
  type SpannerToolSettingsOptions,
} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';

describe('SpannerToolSettings and SpannerCapabilities', () => {
  it('exposes the expected string value for SpannerCapabilities.DATA_READ', () => {
    expect(SpannerCapabilities.DATA_READ).toBe('data_read');
  });

  it('defaults capabilities to [DATA_READ] and maxExecutedQueryResultRows to 50', () => {
    const emptyOptions: SpannerToolSettingsOptions = {};
    const settings = new SpannerToolSettings(emptyOptions);
    expect(settings.capabilities).toEqual([SpannerCapabilities.DATA_READ]);
    expect(settings.maxExecutedQueryResultRows).toBe(50);
  });

  it('defensively copies caller-supplied capabilities on construction', () => {
    const inputCapabilities = [SpannerCapabilities.DATA_READ];
    const settings = new SpannerToolSettings({
      capabilities: inputCapabilities,
    });
    inputCapabilities.length = 0;

    expect(settings.capabilities).toEqual([SpannerCapabilities.DATA_READ]);
  });

  it('accepts custom valid capabilities and maxExecutedQueryResultRows values', () => {
    const singleRow = new SpannerToolSettings({
      capabilities: [],
      maxExecutedQueryResultRows: 1,
    });
    expect(singleRow.capabilities).toEqual([]);
    expect(singleRow.maxExecutedQueryResultRows).toBe(1);

    const hundredRows = new SpannerToolSettings({
      maxExecutedQueryResultRows: 100,
    });
    expect(hundredRows.capabilities).toEqual([SpannerCapabilities.DATA_READ]);
    expect(hundredRows.maxExecutedQueryResultRows).toBe(100);
  });

  it('validates row limits through resolveMaxExecutedQueryResultRows', () => {
    expect(resolveMaxExecutedQueryResultRows()).toBe(50);
    expect(resolveMaxExecutedQueryResultRows(25)).toBe(25);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError when maxExecutedQueryResultRows is %s',
    (invalidRows) => {
      expect(
        () =>
          new SpannerToolSettings({maxExecutedQueryResultRows: invalidRows}),
      ).toThrow(RangeError);
      expect(
        () =>
          new SpannerToolSettings({maxExecutedQueryResultRows: invalidRows}),
      ).toThrow('maxExecutedQueryResultRows must be a positive integer.');
      expect(() => resolveMaxExecutedQueryResultRows(invalidRows)).toThrow(
        RangeError,
      );
    },
  );

  it('identifies SpannerToolSettings instances via isSpannerToolSettings', () => {
    const settings = new SpannerToolSettings();
    expect(isSpannerToolSettings(settings)).toBe(true);
    expect(
      isSpannerToolSettings({capabilities: [SpannerCapabilities.DATA_READ]}),
    ).toBe(false);
    expect(isSpannerToolSettings(null)).toBe(false);
    expect(isSpannerToolSettings(undefined)).toBe(false);
    expect(isSpannerToolSettings('settings')).toBe(false);
  });
});
