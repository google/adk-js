/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LocalEnvironment} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * Commands are built from the Node binary running the tests so that they work
 * under both `sh` and `cmd.exe`. The outer double quotes survive both shells;
 * the inner JavaScript string literals stay single-quoted.
 */
const NODE = `"${process.execPath}"`;

/** Spawning a child process is slow on Windows CI runners. */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * How long the commands used by the timeout tests run for. A killed shell can
 * leave the command running, so this also bounds how long cleanup has to wait.
 */
const SURVIVOR_LIFETIME_MS = 5_000;

/** Upper bound on a timed-out call: comfortably short of the command itself. */
const TIMED_OUT_BY_MS = 4_000;

const decoder = new TextDecoder();

describe('LocalEnvironment', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-local-env-test-'));
  });

  afterEach(async () => {
    // A command killed by a timeout outlives the test by up to
    // SURVIVOR_LIFETIME_MS, and Windows refuses to remove a directory that is
    // a live process's cwd; retry until that process exits.
    await fs.rm(tmpRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }, SPAWN_TIMEOUT_MS);

  describe('lifecycle', () => {
    it('reports isInitialized across initialize() and close()', async () => {
      const env = new LocalEnvironment({workingDir: path.join(tmpRoot, 'ws')});
      expect(env.isInitialized).toBe(false);

      await env.initialize();
      expect(env.isInitialized).toBe(true);

      await env.close();
      expect(env.isInitialized).toBe(false);
    });

    it('creates a temporary workspace and removes it on close()', async () => {
      const env = new LocalEnvironment();
      expect(() => env.workingDir).toThrow(
        '`workingDir` is not set. Call initialize() first.',
      );

      await env.initialize();
      const workingDir = env.workingDir;
      expect(path.basename(workingDir)).toMatch(/^adk_workspace_/);
      await expect(fs.access(workingDir)).resolves.toBeUndefined();

      await env.close();
      await expect(fs.access(workingDir)).rejects.toThrow(/ENOENT/);
    });

    it('creates a caller-supplied workspace and keeps it after close()', async () => {
      const workingDir = path.join(tmpRoot, 'nested', 'workspace');
      const env = new LocalEnvironment({workingDir});

      await env.initialize();
      await expect(fs.access(workingDir)).resolves.toBeUndefined();

      await env.close();
      await expect(fs.access(workingDir)).resolves.toBeUndefined();
    });

    it('tolerates close() being called twice', async () => {
      const env = new LocalEnvironment();
      await env.initialize();
      await env.close();

      await expect(env.close()).resolves.toBeUndefined();
    });

    it('keeps the same workspace when initialize() is called twice', async () => {
      const env = new LocalEnvironment();
      await env.initialize();
      const workingDir = env.workingDir;

      await env.initialize();

      expect(env.workingDir).toBe(workingDir);
      await env.close();
    });

    it('creates a fresh temporary workspace when re-initialized', async () => {
      const env = new LocalEnvironment();
      await env.initialize();
      const first = env.workingDir;
      await env.close();

      await env.initialize();

      expect(env.workingDir).not.toBe(first);
      await env.close();
    });

    it('rejects execute, readFile and writeFile before initialize()', async () => {
      const env = new LocalEnvironment({workingDir: path.join(tmpRoot, 'ws')});

      await expect(env.execute(`${NODE} -e ""`)).rejects.toThrow(
        /not initialized/,
      );
      await expect(env.readFile('a.txt')).rejects.toThrow(/not initialized/);
      await expect(env.writeFile('a.txt', 'x')).rejects.toThrow(
        /not initialized/,
      );
    });

    it('rejects execute() after close() even for a caller-supplied workspace', async () => {
      const env = new LocalEnvironment({workingDir: path.join(tmpRoot, 'ws')});
      await env.initialize();
      await env.close();

      await expect(env.execute(`${NODE} -e ""`)).rejects.toThrow(
        /not initialized/,
      );
    });
  });

  describe('files', () => {
    let env: LocalEnvironment;
    let workingDir: string;

    beforeEach(async () => {
      workingDir = path.join(tmpRoot, 'ws');
      env = new LocalEnvironment({workingDir});
      await env.initialize();
    });

    afterEach(async () => {
      await env.close();
    });

    it('round-trips string content', async () => {
      await env.writeFile('hello.txt', 'hello world');

      expect(decoder.decode(await env.readFile('hello.txt'))).toBe(
        'hello world',
      );
    });

    it('round-trips binary content', async () => {
      const raw = Uint8Array.from([0, 1, 2, 255]);

      await env.writeFile('binary.bin', raw);

      expect(Uint8Array.from(await env.readFile('binary.bin'))).toEqual(raw);
    });

    it('preserves explicit CRLF sequences', async () => {
      await env.writeFile('crlf.txt', 'first\r\nsecond\r\n');

      expect(decoder.decode(await env.readFile('crlf.txt'))).toBe(
        'first\r\nsecond\r\n',
      );
    });

    it('creates parent directories when writing', async () => {
      await env.writeFile(path.join('sub', 'dir', 'file.txt'), 'nested');

      expect(decoder.decode(await env.readFile('sub/dir/file.txt'))).toBe(
        'nested',
      );
    });

    it('accepts an absolute path inside the working directory', async () => {
      const absolute = path.join(workingDir, 'absolute.txt');

      await env.writeFile(absolute, 'absolute');

      expect(decoder.decode(await env.readFile(absolute))).toBe('absolute');
    });

    it('rejects parent traversal on both read and write', async () => {
      await fs.writeFile(path.join(tmpRoot, 'outside.txt'), 'secret');

      await expect(
        env.readFile(path.join('..', 'outside.txt')),
      ).rejects.toThrow(/escapes working directory/);
      await expect(
        env.writeFile(path.join('..', 'write-outside.txt'), 'nope'),
      ).rejects.toThrow(/escapes working directory/);
      await expect(
        fs.access(path.join(tmpRoot, 'write-outside.txt')),
      ).rejects.toThrow(/ENOENT/);
    });

    it('rejects the working directory parent itself', async () => {
      await expect(env.readFile('..')).rejects.toThrow(
        /escapes working directory/,
      );
    });

    it('rejects an absolute path outside the working directory', async () => {
      const outside = path.join(tmpRoot, 'outside-absolute.txt');
      await fs.writeFile(outside, 'secret');

      await expect(env.readFile(outside)).rejects.toThrow(
        /escapes working directory/,
      );
    });

    it('rejects a sibling directory that merely shares the name prefix', async () => {
      const sibling = path.join(`${workingDir}-evil`, 'x.txt');

      await expect(env.readFile(sibling)).rejects.toThrow(
        /escapes working directory/,
      );
    });

    it('propagates ENOENT when reading a missing file', async () => {
      await expect(env.readFile('does_not_exist.txt')).rejects.toThrow(
        /ENOENT/,
      );
    });
  });

  describe('execute', () => {
    let env: LocalEnvironment;

    beforeEach(async () => {
      env = new LocalEnvironment({workingDir: path.join(tmpRoot, 'ws')});
      await env.initialize();
    });

    afterEach(async () => {
      await env.close();
    });

    it(
      'captures stdout and reports the documented zero-state result',
      async () => {
        const result = await env.execute(
          `${NODE} -e "process.stdout.write('hello')"`,
        );

        expect(result).toEqual({
          exitCode: 0,
          stdout: 'hello',
          stderr: '',
          timedOut: false,
        });
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'captures stderr',
      async () => {
        const result = await env.execute(
          `${NODE} -e "process.stderr.write('boom')"`,
        );

        expect(result.stderr).toBe('boom');
        expect(result.exitCode).toBe(0);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'propagates a non-zero exit code',
      async () => {
        const result = await env.execute(`${NODE} -e "process.exit(3)"`);

        expect(result.exitCode).toBe(3);
        expect(result.timedOut).toBe(false);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'runs the command in the working directory',
      async () => {
        const result = await env.execute(
          `${NODE} -e "process.stdout.write(process.cwd())"`,
        );

        // Normalise both sides: macOS reaches the temp dir through a symlink,
        // and Windows CI reports it as an 8.3 short path.
        expect(await fs.realpath(result.stdout.trim())).toBe(
          await fs.realpath(env.workingDir),
        );
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'merges envVars into the command environment',
      async () => {
        const scoped = new LocalEnvironment({
          workingDir: path.join(tmpRoot, 'env-ws'),
          envVars: {ADK_TEST_VAR: 'abc'},
        });
        await scoped.initialize();

        try {
          const result = await scoped.execute(
            `${NODE} -e "process.stdout.write(process.env.ADK_TEST_VAR || '')"`,
          );

          expect(result.stdout.trim()).toBe('abc');
        } finally {
          await scoped.close();
        }
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'kills the command and reports timedOut once the timeout elapses',
      async () => {
        const startedAt = Date.now();

        const result = await env.execute(
          `${NODE} -e "setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})"`,
          0.5,
        );

        expect(result.timedOut).toBe(true);
        expect(result.exitCode).not.toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(TIMED_OUT_BY_MS);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'times out even when the command leaves a child holding the pipes open',
      async () => {
        // A shell that forks rather than exec's its command leaves a survivor
        // that keeps stdout/stderr open after the kill. Reproduce that with a
        // script file so no shell-specific syntax is needed.
        await env.writeFile(
          'spawn_survivor.cjs',
          [
            "const {spawn} = require('node:child_process');",
            `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})'], {`,
            "  stdio: 'inherit',",
            '});',
            `setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS});`,
          ].join('\n'),
        );
        const startedAt = Date.now();

        const result = await env.execute(`${NODE} spawn_survivor.cjs`, 0.5);

        expect(result.timedOut).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(TIMED_OUT_BY_MS);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'clears the timer when the command finishes before the timeout',
      async () => {
        const result = await env.execute(
          `${NODE} -e "process.stdout.write('quick')"`,
          SPAWN_TIMEOUT_MS / 1000,
        );

        expect(result.stdout).toBe('quick');
        expect(result.timedOut).toBe(false);
      },
      SPAWN_TIMEOUT_MS,
    );

    it(
      'rejects when the shell cannot be spawned',
      async () => {
        const removed = new LocalEnvironment({
          workingDir: path.join(tmpRoot, 'gone'),
        });
        await removed.initialize();
        await fs.rm(removed.workingDir, {recursive: true, force: true});

        await expect(removed.execute(`${NODE} -e ""`)).rejects.toThrow();

        await removed.close();
      },
      SPAWN_TIMEOUT_MS,
    );
  });
});
