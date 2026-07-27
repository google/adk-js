/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {InvocationContext} from '@google/adk';
import {CodeExecutionLanguage, VertexAiCodeExecutor} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

/**
 * Live end-to-end test against the managed Vertex AI Code Interpreter Extension.
 *
 * This test is skipped by default so CI stays hermetic; it only runs when the
 * opt-in flag is set alongside a real project and Application Default
 * Credentials. To run it locally:
 *   gcloud auth application-default login
 *   export GOOGLE_CLOUD_PROJECT=<your-project>
 *   # optional: export CODE_INTERPRETER_EXTENSION_NAME=<existing-extension>
 *   RUN_VERTEX_AI_CODE_EXECUTOR_E2E=true npx vitest run --project e2e tests/e2e/code_executors
 */
describe('VertexAiCodeExecutor (live)', () => {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasRequiredEnv =
    process.env.RUN_VERTEX_AI_CODE_EXECUTOR_E2E === 'true' &&
    !!process.env.GOOGLE_CLOUD_PROJECT;
  const invocationContext = {} as unknown as InvocationContext;

  it.skipIf(!hasRequiredEnv)(
    'runs Python, returns stdout + a png, and reuses session state',
    async () => {
      const executor = new VertexAiCodeExecutor();
      const executionId = `e2e-session-${Date.now()}`;

      // First call defines a variable and generates a matplotlib png.
      const first = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: [
            'shared_value = 41',
            'print("first call", shared_value)',
            'plt.plot([1, 2, 3], [4, 5, 6])',
            "plt.savefig('plot.png')",
          ].join('\n'),
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
          executionId,
        },
      });

      expect(first.stdout).toContain('first call 41');
      const png = first.outputFiles.find((f) => f.name.endsWith('.png'));
      expect(png).toBeDefined();
      expect(png!.mimeType).toBe('image/png');
      expect(png!.content.length).toBeGreaterThan(0);

      // Second call in the same session reuses state defined in the first call,
      // proving the same session_id is honored by the managed extension.
      const second = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print("second call", shared_value + 1)',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
          executionId,
        },
      });

      expect(second.stdout).toContain('second call 42');
    },
    300000,
  );
});
