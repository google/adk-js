/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// These cases run against the real filesystem. They cannot live in
// file_utils_test.ts, which mocks `node:fs/promises` module-wide and therefore
// makes the actual `mkdtemp` behaviour under test here unobservable.

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {createTempDir} from '../../src/utils/file_utils.js';

describe('createTempDir', () => {
  const createdDirs: string[] = [];
  const plantedLinks: string[] = [];
  let prefix = '';

  function trackedPrefix(): string {
    prefix = `adk_test_${randomUUID()}`;
    return prefix;
  }

  async function create(): Promise<string> {
    const dir = await createTempDir(prefix);
    createdDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const link of plantedLinks.splice(0)) {
      await fs.unlink(link);
    }
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('returns a directory that exists and is empty', async () => {
    trackedPrefix();

    const dir = await create();

    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(await fs.readdir(dir)).toHaveLength(0);
  });

  it('creates the directory directly under the temp root', async () => {
    trackedPrefix();

    const dir = await create();

    expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir).startsWith(`${prefix}-`)).toBe(true);
  });

  it('creates no predictable intermediate directory', async () => {
    trackedPrefix();

    await create();

    await expect(fs.stat(path.join(os.tmpdir(), prefix))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'creates the directory private to the current user',
    async () => {
      trackedPrefix();

      const dir = await create();

      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    },
  );

  it('returns a distinct directory on every call', async () => {
    trackedPrefix();

    const first = await create();
    const second = await create();

    expect(first).not.toBe(second);
    expect((await fs.stat(first)).isDirectory()).toBe(true);
    expect((await fs.stat(second)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores a symlink planted at the predictable parent path',
    async () => {
      trackedPrefix();
      const attackerDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'adk_test_attacker-'),
      );
      createdDirs.push(attackerDir);
      const link = path.join(os.tmpdir(), prefix);
      await fs.symlink(attackerDir, link);
      plantedLinks.push(link);
      expect(await fs.realpath(link)).toBe(await fs.realpath(attackerDir));

      const dir = await create();

      expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
      expect(path.dirname(await fs.realpath(dir))).not.toBe(
        await fs.realpath(attackerDir),
      );
      expect(await fs.readdir(attackerDir)).toHaveLength(0);
    },
  );
});
