/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  ContainerCodeExecutor,
  ExecuteCodeParams,
  InvocationContext,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * Real-Docker end-to-end tests. These require a reachable Docker daemon and a
 * Python-capable image, so they are opt-in: set ADK_RUN_DOCKER_IT=1 to run them
 * (they never run in CI). Image: `python:3-slim` (an official multi-arch tag).
 */
const shouldRun = !!process.env.ADK_RUN_DOCKER_IT;
const IMAGE = process.env.ADK_DOCKER_IT_IMAGE || 'python:3-slim';

function makeParams(code: string): ExecuteCodeParams {
  return {
    invocationContext: {} as unknown as InvocationContext,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  };
}

describe.skipIf(!shouldRun)('ContainerCodeExecutor (real Docker)', () => {
  let executor: ContainerCodeExecutor | undefined;

  afterEach(async () => {
    await executor?.close();
    executor = undefined;
  });

  it('executes python code and captures stdout', async () => {
    executor = new ContainerCodeExecutor({image: IMAGE});

    const result = await executor.executeCode(makeParams('print(1 + 1)'));

    expect(result.stdout).toBe('2\n');
    expect(result.stderr).toBe('');
    expect(result.outputFiles).toEqual([]);
  }, 120_000);

  it('blocks outbound network access by default', async () => {
    executor = new ContainerCodeExecutor({image: IMAGE});

    // Attempt to reach the cloud metadata endpoint; with networking disabled
    // this must fail rather than return host credentials.
    const code = [
      'import socket',
      's = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
      's.settimeout(3)',
      'try:',
      '    s.connect(("169.254.169.254", 80))',
      '    print("CONNECTED")',
      'except Exception as e:',
      '    print("BLOCKED")',
    ].join('\n');

    const result = await executor.executeCode(makeParams(code));

    expect(result.stdout).toContain('BLOCKED');
    expect(result.stdout).not.toContain('CONNECTED');
  }, 120_000);

  it('allows outbound network access when explicitly enabled', async () => {
    executor = new ContainerCodeExecutor({image: IMAGE, networkEnabled: true});

    const code = [
      'import socket',
      'print("OK" if socket.socket(socket.AF_INET, socket.SOCK_STREAM) else "NO")',
    ].join('\n');

    const result = await executor.executeCode(makeParams(code));

    expect(result.stdout).toContain('OK');
  }, 120_000);
});
