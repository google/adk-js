/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {ExecuteCodeParams} from '../../src/code_executors/base_code_executor.js';
import {UnsafeLocalCodeExecutor} from '../../src/code_executors/unsafe_local_code_executor.js';

describe('UnsafeLocalCodeExecutor', () => {
  let executor: UnsafeLocalCodeExecutor;

  beforeEach(() => {
    executor = new UnsafeLocalCodeExecutor();
  });

  it('should execute simple code and return stdout', async () => {
    const params: ExecuteCodeParams = {
      codeExecutionInput: {
        code: 'console.log("hello")',
        inputFiles: [],
      },
      invocationContext: {} as any,
    };
    const result = await executor.executeCode(params);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.outputFiles).toEqual([]);
  });

  it('should capture stderr', async () => {
    const params: ExecuteCodeParams = {
      codeExecutionInput: {
        code: 'console.error("error")',
        inputFiles: [],
      },
      invocationContext: {} as any,
    };
    const result = await executor.executeCode(params);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('error');
  });

  it('should handle timeout', async () => {
    // Use a short timeout for testing
    const timeoutExecutor = new UnsafeLocalCodeExecutor({timeoutSeconds: 1});
    const params: ExecuteCodeParams = {
      codeExecutionInput: {
        // Code that takes longer than the timeout
        code: 'setTimeout(() => { console.log("done"); }, 5000);',
        inputFiles: [],
      },
      invocationContext: {} as any,
    };
    const result = await timeoutExecutor.executeCode(params);
    expect(result.stderr).toContain('Code execution timed out after 1 seconds');
  });

  it('should handle invalid code with syntax error', async () => {
    const params: ExecuteCodeParams = {
      codeExecutionInput: {
        code: 'const a =;', // Syntax error
        inputFiles: [],
      },
      invocationContext: {} as any,
    };
    const result = await executor.executeCode(params);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SyntaxError');
  });
});
