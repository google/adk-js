/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {ChildProcessWithoutNullStreams, exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const execAsync = promisify(exec);
const dirname = process.cwd();

const TEST_EXECUTION_TIMEOUT = 20000;

function sendInput(
  childProcess: ChildProcessWithoutNullStreams,
  input: string,
): Promise<string> {
  childProcess.stdin.write(input);
  childProcess.stdin.end();

  return getResponse(childProcess);
}

function getResponse(
  childProcess: ChildProcessWithoutNullStreams,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let output = '';
    let resolved = false;

    const onFinish = () => {
      if (!resolved) {
        resolve(output);
      }

      childProcess.stdout.off('data', onData);
      resolved = true;
    };

    const onData = (data: Buffer) => {
      output += data.toString();
    };

    childProcess.stdout.on('data', onData);
    childProcess.stdout.once('end', onFinish);
    childProcess.stdout.once('close', onFinish);
  });
}

describe('Build setup', () => {
  describe.each([
    'js_commonjs',
    'js_esm',
    'ts_commonjs',
    'ts_esm',
    'ts_commonjs_native_addon',
    'ts_esm_native_addon',
  ])('%s', (buildSetup: string) => {
    const projectPath = `${dirname}/tests/integration/build_setup/${buildSetup}`;

    beforeAll(async () => {
      await execAsync('npm install', {cwd: projectPath});

      if (buildSetup.startsWith('ts_')) {
        let buildResult;
        try {
          buildResult = await execAsync('npm run build', {
            cwd: projectPath,
          });
        } catch (error: unknown) {
          console.error(`Build failed for ${buildSetup}:`);
          console.error(`stdout:\n${(error as {stdout: string}).stdout}`);
          console.error(`stderr:\n${(error as {stderr: string}).stderr}`);
          throw error;
        }
        expect(buildResult.stderr).toBe('');
        expect(buildResult.stdout).toContain('\nBuild complete');
      }
    });

    it(
      'should build and run agent successfully',
      async () => {
        const childProcess = spawn('npm', ['run', 'start'], {
          cwd: projectPath,
          shell: true,
        });

        let response = await sendInput(childProcess, 'Tell me a joke.\n');
        expect(response.toString()).toContain('test-llm-model-response');

        response = await sendInput(childProcess, 'exit\n');
        expect(response.toString()).toContain('');
      },
      TEST_EXECUTION_TIMEOUT,
    );

    it.skipIf(
      !['js_commonjs', 'js_esm', 'ts_commonjs', 'ts_esm'].includes(buildSetup),
    )(
      'should handle dynamic imports in DatabaseSessionService',
      async () => {
        const childProcess = spawn('npm', ['run', 'test:db'], {
          cwd: projectPath,
          shell: true,
        });

        const response = await getResponse(childProcess);
        expect(response.toString()).toContain('DYNAMIC_IMPORT_SUCCESS');
      },
      TEST_EXECUTION_TIMEOUT,
    );

    afterAll(async () => {
      await fs
        .rm(`${projectPath}/node_modules`, {recursive: true, force: true})
        .catch(() => {});
      await fs.unlink(`${projectPath}/package-lock.json`).catch(() => {});

      if (buildSetup.startsWith('ts_')) {
        await fs
          .rm(`${projectPath}/dist`, {recursive: true, force: true})
          .catch(() => {});
      }
    });
  });
});
