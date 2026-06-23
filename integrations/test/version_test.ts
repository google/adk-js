/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';

describe('version', () => {
  it('should return the correct version', () => {
    expect(version).toBe('1.3.0');
  });
});
