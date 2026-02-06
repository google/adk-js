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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['core/src/**/*.ts', 'dev/src/**/*.ts'],
      exclude: [
        './dev/src/browser/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
      ],
      // Those values are from the npm run test:coverage command run on 2026-02-06
      // and are used to ensure that the test coverage does not decrease.
      // Once the test coverage increases, these values should be updated (manually).
      thresholds: {
        statements: 53,
        branches: 76,
        functions: 59,
        lines: 53,
      },
    },
  },
  resolve: {alias: {'@google/adk': path.resolve(__dirname, './core/src')}},
});
