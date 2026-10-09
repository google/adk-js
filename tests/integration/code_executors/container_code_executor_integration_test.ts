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
 * Real-Docker integration tests. They require a reachable Docker daemon and an
 * image that ships every runtime in {@link CodeExecutionLanguage}
 * (`python3`, `node`, `tsx`, `sh`), so they are opt-in: set ADK_RUN_DOCKER_IT=1
 * to run them. CI builds that image from
 * `tests/integration/code_executors/docker/Dockerfile` and runs this file with
 * the flag set (see `.github/workflows/container-code-executor.yml`).
 */
const shouldRun = !!process.env.ADK_RUN_DOCKER_IT;
const IMAGE = process.env.ADK_DOCKER_IT_IMAGE || 'adk-code-executor-it:latest';

function makeParams(
  code: string,
  language: CodeExecutionLanguage,
  sessionId = 'integration-test-session',
): ExecuteCodeParams {
  return {
    invocationContext: {
      session: {
        appName: 'integration-test-app',
        userId: 'integration-test-user',
        id: sessionId,
      },
    } as unknown as InvocationContext,
    codeExecutionInput: {code, language, inputFiles: []},
  };
}

/** One language, the code that prints `2`, and the stdout the run must emit. */
interface LanguageCase {
  name: string;
  language: CodeExecutionLanguage;
  code: string;
  expectedStdout: string;
}

const LANGUAGE_CASES: LanguageCase[] = [
  {
    name: 'python',
    language: CodeExecutionLanguage.PYTHON,
    code: 'print(1 + 1)',
    expectedStdout: '2\n',
  },
  {
    name: 'javascript',
    language: CodeExecutionLanguage.JAVASCRIPT,
    code: 'console.log(1 + 1)',
    expectedStdout: '2\n',
  },
  {
    name: 'typescript',
    language: CodeExecutionLanguage.TYPESCRIPT,
    code: 'const sum: number = 1 + 1;\nconsole.log(sum);',
    expectedStdout: '2\n',
  },
  {
    name: 'shell',
    language: CodeExecutionLanguage.SHELL,
    code: 'echo $((1 + 1))',
    expectedStdout: '2\n',
  },
];

describe.skipIf(!shouldRun)('ContainerCodeExecutor (real Docker)', () => {
  let executor: ContainerCodeExecutor | undefined;

  afterEach(async () => {
    await executor?.close();
    executor = undefined;
  });

  it.each(LANGUAGE_CASES)(
    'runs $name code and captures stdout',
    async ({language, code, expectedStdout}) => {
      executor = new ContainerCodeExecutor({image: IMAGE});

      const result = await executor.executeCode(makeParams(code, language));

      expect(result.stdout).toBe(expectedStdout);
      expect(result.stderr).toBe('');
      expect(result.outputFiles).toEqual([]);
    },
    120_000,
  );

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

    const result = await executor.executeCode(
      makeParams(code, CodeExecutionLanguage.PYTHON),
    );

    expect(result.stdout).toContain('BLOCKED');
    expect(result.stdout).not.toContain('CONNECTED');
  }, 120_000);

  it('allows outbound network access when explicitly enabled', async () => {
    executor = new ContainerCodeExecutor({image: IMAGE, networkEnabled: true});

    // Actually connect to a public host (Google Public DNS over TCP). Merely
    // constructing a socket succeeds even with networking disabled, so it would
    // not prove the opt-in took effect.
    const code = [
      'import socket',
      'try:',
      '    socket.create_connection(("8.8.8.8", 53), timeout=5).close()',
      '    print("CONNECTED")',
      'except Exception:',
      '    print("BLOCKED")',
    ].join('\n');

    const result = await executor.executeCode(
      makeParams(code, CodeExecutionLanguage.PYTHON),
    );

    expect(result.stdout).toContain('CONNECTED');
    expect(result.stdout).not.toContain('BLOCKED');
  }, 120_000);
});
