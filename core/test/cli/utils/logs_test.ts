/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  logger,
  LOGGING_FORMAT,
  LogLevel,
  logToStderr,
  logToTmpFolder,
  setLogger,
  setupAdkLogger,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

  describe('logToStderr', () => {
    it('writes log records at or above the configured level to process.stderr', () => {
      const writes: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

      logToStderr(LogLevel.INFO);
      logger.debug('debug-hidden');
      logger.info('info-visible');
      logger.warn('warn-visible');

      expect(writes.some((w) => w.includes('debug-hidden'))).toBe(false);
      expect(writes.some((w) => w.includes('INFO - info-visible'))).toBe(true);
      expect(writes.some((w) => w.includes('WARNING - warn-visible'))).toBe(
        true,
      );
    });
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

      expect(writes.some((w) => w.includes('DEBUG - debug-visible'))).toBe(
        true,
      );
      expect(writes.some((w) => w.includes('INFO - info-visible'))).toBe(true);
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

      expect(writes.some((w) => w.includes('debug-filtered'))).toBe(false);
      expect(writes.some((w) => w.includes('INFO - info-emitted'))).toBe(true);
    });
  });
});
