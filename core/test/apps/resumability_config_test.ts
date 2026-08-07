/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createResumabilityConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createResumabilityConfig', () => {
  it('should default to isResumable = false when no params given', () => {
    const config = createResumabilityConfig();
    expect(config.isResumable).toBe(false);
  });

  it('should override defaults with provided params', () => {
    const config = createResumabilityConfig({isResumable: true});
    expect(config.isResumable).toBe(true);
  });
});
