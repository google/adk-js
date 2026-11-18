/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  logger,
  LOGGING_FORMAT,
  LogLevel,
  logToTmpFolder,
  setLogger,
  setupAdkLogger,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});

describe('cli/utils/logs', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    setLogger(null);
    vi.restoreAllMocks();
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('exports the standard LOGGING_FORMAT string', () => {
    expect(LOGGING_FORMAT).toBe(
      '%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s',
    );
  });

  describe('logToTmpFolder', () => {
    it('creates a timestamped log file, writes log records, and updates the .latest.log symlink', () => {
      const subFolder = `adk_logs_test_${Date.now()}`;
      createdDirs.push(path.join(os.tmpdir(), subFolder));

      const firstLogPath = logToTmpFolder({
        level: LogLevel.DEBUG,
        subFolder,
        logFilePrefix: 'my_agent',
        logFileTimestamp: '20260101_000001',
      });

      logger.debug('first-file-debug-entry');

      expect(fs.existsSync(firstLogPath)).toBe(true);
      expect(fs.readFileSync(firstLogPath, 'utf-8')).toContain(
        'first-file-debug-entry',
      );

      const secondLogPath = logToTmpFolder({
        level: LogLevel.INFO,
        subFolder,
        logFilePrefix: 'my_agent',
        logFileTimestamp: '20260101_000002',
      });

      logger.info('second-file-info-entry');

      const latestLink = path.join(
        os.tmpdir(),
        subFolder,
        'my_agent.latest.log',
      );
      expect(fs.lstatSync(latestLink).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(latestLink)).toBe(fs.realpathSync(secondLogPath));
      expect(fs.readFileSync(latestLink, 'utf-8')).toContain(
        'second-file-info-entry',
      );
    });

    let testCounter = 0;
    function uniqueSubFolder(): string {
      const subFolder = `adk_logs_test_${process.pid}_${Date.now()}_${testCounter++}`;
      createdDirs.push(path.join(os.tmpdir(), subFolder));
      return subFolder;
    }

    function silenceStderr(): string[] {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      return writes;
    }

    it.skipIf(process.platform === 'win32')(
      'creates the directory with mode 0o700 and the file with mode 0o600',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();

        const logPath = logToTmpFolder({subFolder});

        const logDir = path.join(os.tmpdir(), subFolder);
        expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'restricts an existing directory to mode 0o700',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.mkdirSync(logDir, {mode: 0o755});
        fs.chmodSync(logDir, 0o755);

        logToTmpFolder({subFolder});

        expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
      },
    );

    it('writes the log file location to stderr', () => {
      const writes = silenceStderr();

      const logPath = logToTmpFolder({subFolder: uniqueSubFolder()});

      expect(writes).toContain(`Log setup complete: ${logPath}\n`);
    });

    it('includes the process ID in the default timestamp', () => {
      silenceStderr();

      const logPath = logToTmpFolder({subFolder: uniqueSubFolder()});

      expect(path.basename(logPath)).toMatch(
        new RegExp(`^agent\\.\\d{8}_\\d{6}_${process.pid}\\.log$`),
      );
    });

    it('adds a numeric suffix instead of truncating an existing file', () => {
      silenceStderr();
      const subFolder = uniqueSubFolder();
      const logDir = path.join(os.tmpdir(), subFolder);
      fs.mkdirSync(logDir, {recursive: true});
      const existingPath = path.join(logDir, 'agent.20260101_000001.log');
      fs.writeFileSync(existingPath, 'existing');

      const secondPath = logToTmpFolder({
        subFolder,
        logFileTimestamp: '20260101_000001',
      });
      const thirdPath = logToTmpFolder({
        subFolder,
        logFileTimestamp: '20260101_000001',
      });

      expect(path.basename(secondPath)).toBe('agent.20260101_000001_1.log');
      expect(path.basename(thirdPath)).toBe('agent.20260101_000001_2.log');
      expect(fs.readFileSync(existingPath, 'utf-8')).toBe('existing');
    });

    it.skipIf(process.platform === 'win32')(
      'does not follow an existing symlink at the log file path',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.mkdirSync(logDir, {recursive: true});
        const targetPath = path.join(logDir, 'target.txt');
        fs.writeFileSync(targetPath, 'target-content');
        fs.symlinkSync(
          targetPath,
          path.join(logDir, 'agent.20260101_000001.log'),
        );

        const logPath = logToTmpFolder({
          subFolder,
          logFileTimestamp: '20260101_000001',
        });
        logger.info('new-entry');

        expect(path.basename(logPath)).toBe('agent.20260101_000001_1.log');
        expect(fs.readFileSync(targetPath, 'utf-8')).toBe('target-content');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'rethrows a file creation error other than EEXIST',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.mkdirSync(logDir, {recursive: true});
        fs.writeFileSync(path.join(logDir, 'blocker'), '');

        expect(() =>
          logToTmpFolder({
            subFolder,
            logFilePrefix: 'blocker/agent',
            logFileTimestamp: '20260101_000001',
          }),
        ).toThrow(expect.objectContaining({code: 'ENOTDIR'}));
        expect(fs.readdirSync(logDir)).toEqual(['blocker']);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'keeps writing to the open file after the path is replaced with a symlink',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const logPath = logToTmpFolder({subFolder});
        const logDir = path.dirname(logPath);
        const targetPath = path.join(logDir, 'target.txt');
        fs.writeFileSync(targetPath, 'target-content');
        const fd = fs.openSync(logPath, 'r');

        fs.unlinkSync(logPath);
        fs.symlinkSync(targetPath, logPath);
        logger.info('entry-after-swap');

        expect(fs.readFileSync(targetPath, 'utf-8')).toBe('target-content');
        expect(fs.readFileSync(fd, 'utf-8')).toContain('entry-after-swap');
        fs.closeSync(fd);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'uses a user-scoped directory when the log directory is a symlink',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const userLogDir = path.join(
          os.tmpdir(),
          `${subFolder}_${process.getuid?.()}`,
        );
        createdDirs.push(userLogDir);
        const symlinkTarget = fs.mkdtempSync(
          path.join(os.tmpdir(), 'adk_logs_target_'),
        );
        createdDirs.push(symlinkTarget);
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.symlinkSync(symlinkTarget, logDir);

        const logPath = logToTmpFolder({subFolder});

        expect(path.dirname(logPath)).toBe(userLogDir);
        expect(fs.lstatSync(logDir).isSymbolicLink()).toBe(true);
        expect(fs.readdirSync(symlinkTarget)).toEqual([]);
        fs.unlinkSync(logDir);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'uses a user-scoped directory when the log directory is a dangling symlink',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const userLogDir = path.join(
          os.tmpdir(),
          `${subFolder}_${process.getuid?.()}`,
        );
        createdDirs.push(userLogDir);
        const missingTarget = path.join(
          os.tmpdir(),
          `${subFolder}_missing`,
          'target',
        );
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.symlinkSync(missingTarget, logDir);

        const logPath = logToTmpFolder({subFolder});

        expect(path.dirname(logPath)).toBe(userLogDir);
        expect(fs.lstatSync(logDir).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.dirname(missingTarget))).toBe(false);
        fs.unlinkSync(logDir);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'uses a user-scoped directory when the log directory is a file',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const userLogDir = path.join(
          os.tmpdir(),
          `${subFolder}_${process.getuid?.()}`,
        );
        createdDirs.push(userLogDir);
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.writeFileSync(logDir, 'not-a-directory');

        const logPath = logToTmpFolder({subFolder});

        expect(path.dirname(logPath)).toBe(userLogDir);
        expect(fs.readFileSync(logDir, 'utf-8')).toBe('not-a-directory');
        fs.rmSync(logDir);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'uses a user-scoped directory when another user owns the log directory',
      () => {
        silenceStderr();
        const subFolder = uniqueSubFolder();
        const uid = process.getuid?.() ?? 0;
        const userLogDir = path.join(os.tmpdir(), `${subFolder}_${uid}`);
        createdDirs.push(userLogDir);
        const logDir = path.join(os.tmpdir(), subFolder);
        fs.mkdirSync(logDir, {mode: 0o777});
        fs.chmodSync(logDir, 0o777);
        const realStat = fs.statSync(logDir);
        vi.mocked(fs.lstatSync).mockImplementationOnce(() =>
          Object.assign(realStat, {uid: uid + 1}),
        );

        const logPath = logToTmpFolder({subFolder});

        expect(path.dirname(logPath)).toBe(userLogDir);
        expect(fs.statSync(logDir).mode & 0o777).toBe(0o777);
        expect(fs.statSync(userLogDir).mode & 0o777).toBe(0o700);
      },
    );

    it('throws when every numeric suffix is taken', () => {
      silenceStderr();
      const subFolder = uniqueSubFolder();
      const logDir = path.join(os.tmpdir(), subFolder);
      fs.mkdirSync(logDir, {recursive: true});
      fs.writeFileSync(path.join(logDir, 'agent.20260101_000001.log'), '');
      for (let i = 1; i <= 1000; i++) {
        fs.writeFileSync(
          path.join(logDir, `agent.20260101_000001_${i}.log`),
          '',
        );
      }

      expect(() =>
        logToTmpFolder({subFolder, logFileTimestamp: '20260101_000001'}),
      ).toThrow('Failed to create a unique log file');
    });

    it('formats file log records with an ISO-8601 timestamp and no template tokens', () => {
      silenceStderr();
      const subFolder = uniqueSubFolder();
      const logPath = logToTmpFolder({
        level: LogLevel.INFO,
        subFolder,
        logFilePrefix: 'format_test',
        logFileTimestamp: '20260101_000001',
      });

      logger.info('file log message');

      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z - INFO - Log setup complete: /,
      );
      expect(lines[1]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z - INFO - file log message$/,
      );
      expect(content).not.toContain('%(asctime)s');
      expect(content).not.toContain('%(levelname)s');
      expect(content).not.toContain('%(filename)s');
      expect(content).not.toContain('%(lineno)d');
      expect(content).not.toContain('%(message)s');
    });
  });

  describe('setupAdkLogger', () => {
    it('configures the global logger to write to stderr at the requested level', () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      setupAdkLogger(LogLevel.DEBUG);
      logger.debug('debug-visible');
      logger.info('info-visible');
      logger.warn('warn-visible');

      expect(writes.some((w) => w.includes('DEBUG - debug-visible'))).toBe(
        true,
      );
      expect(writes.some((w) => w.includes('INFO - info-visible'))).toBe(true);
      expect(writes.some((w) => w.includes('WARNING - warn-visible'))).toBe(
        true,
      );
    });

    it('defaults to LogLevel.INFO when no level is provided', () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      setupAdkLogger();
      logger.debug('debug-filtered');
      logger.info('info-emitted');
      logger.warn('warn-emitted');

      expect(writes.some((w) => w.includes('debug-filtered'))).toBe(false);
      expect(writes.some((w) => w.includes('INFO - info-emitted'))).toBe(true);
      expect(writes.some((w) => w.includes('WARNING - warn-emitted'))).toBe(
        true,
      );
    });

    it('formats log lines with an ISO-8601 timestamp and no template tokens', () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      setupAdkLogger(LogLevel.INFO);
      logger.info('formatted log message');

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z - INFO - formatted log message\n$/,
      );
      expect(writes[0]).not.toContain('%(asctime)s');
      expect(writes[0]).not.toContain('%(levelname)s');
      expect(writes[0]).not.toContain('%(filename)s');
      expect(writes[0]).not.toContain('%(lineno)d');
      expect(writes[0]).not.toContain('%(message)s');
    });

    it('closes the log file that logToTmpFolder opened', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const subFolder = `adk_logs_test_${process.pid}_${Date.now()}_close`;
      createdDirs.push(path.join(os.tmpdir(), subFolder));
      const logPath = logToTmpFolder({subFolder});
      vi.mocked(fs.closeSync).mockClear();

      setupAdkLogger();
      logger.info('entry-after-switch');

      expect(fs.closeSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(logPath, 'utf-8')).not.toContain(
        'entry-after-switch',
      );
    });
  });
});
