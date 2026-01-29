/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*_test.ts'],
  },
  resolve: {alias: {'@google/adk': path.resolve(__dirname, './core/src')}},
});
