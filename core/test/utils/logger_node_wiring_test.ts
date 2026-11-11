/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {WinstonLogger} from '../../src/utils/logger_node.js';

/**
 * Nothing in this file may call `resetLogger()` or `setLogger()`: the point is
 * that importing the Node entry point is what installs the winston logger.
 */
describe('Node entry point', () => {
  it('installs the winston logger on import', () => {
    expect(getLogger()).toBeInstanceOf(WinstonLogger);
  });
});
