/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {formatHeaderForLog} from '../../src/utils/log_utils.js';

describe('formatHeaderForLog', () => {
  it('quotes the value so an injected newline cannot forge a log line', () => {
    expect(formatHeaderForLog('evil.example\ninjected')).toBe(
      '"evil.example\\ninjected"',
    );
  });

  it('truncates a value longer than the cap', () => {
    const long = 'a'.repeat(200);
    expect(formatHeaderForLog(long)).toBe(`"${'a'.repeat(128)}"`);
  });

  it('coerces a missing or array-valued header to a string', () => {
    expect(formatHeaderForLog(undefined)).toBe('"undefined"');
    expect(formatHeaderForLog(['a', 'b'])).toBe('"a,b"');
  });
});
