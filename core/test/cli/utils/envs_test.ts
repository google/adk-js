/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {loadDotenvForAgent, walkToRootUntilFound} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('cli/utils/envs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-envs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
    delete process.env['ADK_TEST_ENV_KEY_1'];
    delete process.env['ADK_TEST_ENV_KEY_2'];
    delete process.env['ADK_TEST_ENV_QUOTED'];
    delete process.env['ADK_TEST_ENV_SINGLE'];
  });

  describe('walkToRootUntilFound', () => {
    it('finds a .env file in the starting directory', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'ADK_TEST_ENV_KEY_1=1\n');

      expect(walkToRootUntilFound(tempDir)).toBe(path.resolve(envPath));
    });

    it('walks up parent directories until the file is found', () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'ADK_TEST_ENV_KEY_1=parent\n');
      const nestedDir = path.join(tempDir, 'a', 'b', 'c');
      fs.mkdirSync(nestedDir, {recursive: true});

      expect(walkToRootUntilFound(nestedDir)).toBe(path.resolve(envPath));
    });

    it('supports a custom filename', () => {
      const customPath = path.join(tempDir, '.env.custom');
      fs.writeFileSync(customPath, 'ADK_TEST_ENV_KEY_1=custom\n');
      const nestedDir = path.join(tempDir, 'nested');
      fs.mkdirSync(nestedDir, {recursive: true});

      expect(walkToRootUntilFound(nestedDir, '.env.custom')).toBe(
        path.resolve(customPath),
      );
    });

    it('ignores a directory that has the target filename', () => {
      const dirNamedEnv = path.join(tempDir, 'child', '.env');
      fs.mkdirSync(dirNamedEnv, {recursive: true});
      const parentEnv = path.join(tempDir, '.env');
      fs.writeFileSync(parentEnv, 'ADK_TEST_ENV_KEY_1=file\n');

      expect(walkToRootUntilFound(path.join(tempDir, 'child'))).toBe(
        path.resolve(parentEnv),
      );
    });

    it('returns empty string when reaching root without finding the file', () => {
      expect(
        walkToRootUntilFound(tempDir, '.nonexistent_adk_env_file_xyz'),
      ).toBe('');
    });
  });

  describe('loadDotenvForAgent', () => {
    it('loads .env variables and overrides existing process.env values', () => {
      process.env['ADK_TEST_ENV_KEY_1'] = 'old_value';
      const agentDir = path.join(tempDir, 'my_agent');
      fs.mkdirSync(agentDir, {recursive: true});
      fs.writeFileSync(
        path.join(agentDir, '.env'),
        [
          '# Comment line',
          'ADK_TEST_ENV_KEY_1=new_value # inline comment',
          'export ADK_TEST_ENV_KEY_2 = exported_val',
          'ADK_TEST_ENV_QUOTED="line1\\nline2"',
          "ADK_TEST_ENV_SINGLE='single quoted # not comment'",
        ].join('\n'),
      );

      loadDotenvForAgent('my_agent', tempDir);

      expect(process.env['ADK_TEST_ENV_KEY_1']).toBe('new_value');
      expect(process.env['ADK_TEST_ENV_KEY_2']).toBe('exported_val');
      expect(process.env['ADK_TEST_ENV_QUOTED']).toBe('line1\nline2');
      expect(process.env['ADK_TEST_ENV_SINGLE']).toBe(
        'single quoted # not comment',
      );
    });

    it('accepts an agent file path and walks up from its directory', () => {
      const agentDir = path.join(tempDir, 'file_agent');
      fs.mkdirSync(agentDir, {recursive: true});
      const agentFile = path.join(agentDir, 'agent.ts');
      fs.writeFileSync(agentFile, '');
      fs.writeFileSync(path.join(tempDir, '.env'), 'ADK_TEST_ENV_KEY_1=root\n');

      loadDotenvForAgent(agentFile);

      expect(process.env['ADK_TEST_ENV_KEY_1']).toBe('root');
    });

    it('succeeds without throwing when no .env file exists', () => {
      expect(() =>
        loadDotenvForAgent(
          'missing_agent',
          tempDir,
          '.nonexistent_adk_env_file_xyz',
        ),
      ).not.toThrow();
    });
  });
});
