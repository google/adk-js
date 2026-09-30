/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getLogger} from '../../src/utils/logger.js';
import {BrowserLogger} from '../../src/utils/logger_browser.js';

/**
 * Nothing in this file may call `resetLogger()` or `setLogger()`: the point is
 * that importing the browser entry point is what installs the browser logger.
 */
describe('browser entry point', () => {
  it('installs the browser logger on import', async () => {
    await import('../../src/index_web.js');

    expect(getLogger()).toBeInstanceOf(BrowserLogger);
  });
});
