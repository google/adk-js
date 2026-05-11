/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEngineSandboxCodeExecutor,
  CodeExecutionLanguage,
  InvocationContext,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

const runRealE2E = process.env.RUN_REAL_E2E === 'true';

describe.runIf(runRealE2E)('AgentEngineSandboxCodeExecutor Real E2E', () => {
  let executor: AgentEngineSandboxCodeExecutor;
  let invocationContext: InvocationContext;

  beforeAll(() => {
    executor = new AgentEngineSandboxCodeExecutor({
      projectId: 'amaadmartin-claw-15058',
      location: 'us-central1',
    });

    invocationContext = {
      session: {
        id: 'test-session-' + Date.now(),
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
        state: {},
      },
    } as unknown as InvocationContext;
  });

  it('can execute python code in a real sandbox', async () => {
    console.log('Executing Python code in real sandbox...');
    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: `
import sys
print("Hello from real Python Sandbox!")
print("Python version:", sys.version)
`,
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    console.log('Python Result:', result);

    expect(result.stdout).toContain('Hello from real Python Sandbox!');
    expect(result.stderr).toBe('');
    expect(
      invocationContext.session?.state?.[`sandbox_name_language_python`],
    ).toBeDefined();
  }, 300000); // 5m timeout

  it('can execute javascript code in a real sandbox', async () => {
    console.log('Executing JS code in real sandbox...');
    const result = await executor.executeCode({
      invocationContext,
      codeExecutionInput: {
        code: `
console.log("Hello from real JS Sandbox!");
console.log("Node version:", process.version);
`,
        language: CodeExecutionLanguage.JAVASCRIPT,
        inputFiles: [],
      },
    });

    console.log('JS Result:', result);

    expect(result.stdout).toContain('Hello from real JS Sandbox!');
    expect(result.stderr).toBe('');
    expect(
      invocationContext.session?.state?.[`sandbox_name_language_javascript`],
    ).toBeDefined();
    // Verify Python sandbox is still there
    expect(
      invocationContext.session?.state?.[`sandbox_name_language_python`],
    ).toBeDefined();
  }, 300000); // 5m timeout
});
