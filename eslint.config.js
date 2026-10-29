/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

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
    files: ["core/src/**/*.ts"],
    ignores: ["core/src/telemetry/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@opentelemetry", "@opentelemetry/**"],
              message:
                "OpenTelemetry APIs and SDKs must only be imported inside core/src/telemetry/. Use core/src/telemetry/api/instrumentation.js instead.",
            },
            {
              group: [
                "**/telemetry/api/internal/**",
                "**/telemetry/export/**",
                "**/telemetry/tracing*",
                "**/telemetry/setup*",
                "**/telemetry/google_cloud*",
              ],
              message:
                "Import telemetry instrumentation only from core/src/telemetry/api/instrumentation.js.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["core/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@opentelemetry", "@opentelemetry/**"],
              message:
                "OpenTelemetry APIs and SDKs must only be imported inside core/src/telemetry/.",
            },
            {
              group: [
                "**/telemetry/api/internal/**",
                "**/telemetry/tracing*",
                "**/telemetry/setup*",
                "**/telemetry/google_cloud*",
              ],
              message:
                "The public entry point may only re-export telemetry from ./telemetry/export/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["core/src/telemetry/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@opentelemetry/*",
                "!@opentelemetry/api",
                "!@opentelemetry/api-logs",
              ],
              message:
                "core/src/telemetry/api/ may only depend on @opentelemetry/api and @opentelemetry/api-logs. SDK and exporter packages belong in core/src/telemetry/export/.",
            },
            {
              group: [
                "**/telemetry/export/**",
                "../export/**",
                "../../export/**",
                "../../../export/**",
              ],
              message:
                "core/src/telemetry/api/ must not import from core/src/telemetry/export/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["core/src/telemetry/export/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/telemetry/api/**",
                "../api/**",
                "../../api/**",
              ],
              message:
                "core/src/telemetry/export/ must not import from core/src/telemetry/api/.",
            },
          ],
        },
      ],
    },
  },
]);
