/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import {builtinModules} from 'node:module';

/**
 * Bare Node built-in specifiers (`fs`, `path`, `fs/promises`) are banned so
 * a same-named npm package cannot shadow the built-in. The list is derived
 * from Node's own list, so new built-ins are covered without editing this
 * file.
 */
const bareNodeBuiltins = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .map((name) => ({name, message: `Use "node:${name}" instead of "${name}".`}));

export default defineConfig([
  {
    ignores: ["**/dist/**"],
  },
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { js },
    extends: ["js/recommended"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ]
    },
  },
  {
    // Scoped to src until the remaining bare specifiers in test and tooling
    // files are prefixed; widen to '**/*.ts' once that lands.
    files: ['core/src/**/*.ts', 'dev/src/**/*.ts', 'integrations/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {paths: bareNodeBuiltins}],
    },
  },
]);
