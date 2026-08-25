/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, Logger, LogLevel, setLogger, setLogLevel} from '@google/adk';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetLogger} from '../../src/utils/logger.js';

/** Reads a module under `core/src/utils` as text. */
function readCoreSource(name: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../../src/utils/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('setLogger', () => {
  beforeEach(() => {
    resetLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    resetLogger();
  });

  describe('custom logger', () => {
    it('routes log messages to custom logger', () => {
      const messages: Array<{level: string; args: unknown[]}> = [];
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: (level, ...args) => messages.push({level: LogLevel[level], args}),
        debug: (...args) => messages.push({level: 'DEBUG', args}),
        info: (...args) => messages.push({level: 'INFO', args}),
        warn: (...args) => messages.push({level: 'WARN', args}),
        error: (...args) => messages.push({level: 'ERROR', args}),
      };

      setLogger(customLogger);
      const logger = getLogger();

      logger.info('test message', 123);

      expect(messages).toHaveLength(1);
      expect(messages[0].level).toBe('INFO');
      expect(messages[0].args).toEqual(['test message', 123]);
    });

    it('calls correct method for each log level', () => {
      const calls: string[] = [];
      const customLogger: Logger = {
        setLogLevel: () => calls.push('setLogLevel'),
        log: () => calls.push('log'),
        debug: () => calls.push('debug'),
        info: () => calls.push('info'),
        warn: () => calls.push('warn'),
        error: () => calls.push('error'),
      };

      setLogger(customLogger);
      const logger = getLogger();

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(calls).toEqual(['debug', 'info', 'warn', 'error']);
    });
  });

  describe('null logger (disable logging)', () => {
    it('disables all logging when null is passed', () => {
      setLogger(null);
      const logger = getLogger();

      expect(logger.constructor.name).toBe('NoOpLogger');
    });

    it('handles all log levels silently', () => {
      setLogger(null);
      const logger = getLogger();

      expect(() => {
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error');
        logger.log(LogLevel.INFO, 'log');
      }).not.toThrow();
    });
  });

  describe('backward compatibility', () => {
    it('deprecated logger export still works with custom logger', async () => {
      const {logger} = await import('../../src/utils/logger.js');

      const messages: string[] = [];
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: (...args) => messages.push(String(args[0])),
        warn: () => {},
        error: () => {},
      };

      setLogger(customLogger);

      logger.info('backward compatible');

      expect(messages).toContain('backward compatible');
    });
  });

  describe('getLogger', () => {
    it('returns the current logger instance', () => {
      const customLogger: Logger = {
        setLogLevel: () => {},
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      setLogger(customLogger);

      const logger = getLogger();
      expect(logger).toBeDefined();
    });

    it('returns default logger initially', () => {
      const logger = getLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });
  });

  describe('resetLogger', () => {
    it('restores the default logger', () => {
      setLogger(null);
      resetLogger();

      const logger = getLogger();

      expect(logger.constructor.name).toBe('SimpleLogger');
    });
  });
});

describe('SimpleLogger', () => {
  const ISO_TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T[\d:.]+Z`;

  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it('emits a message at the configured level', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setLogLevel(LogLevel.INFO);

    getLogger().info('hello');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^INFO: \\[ADK\\] ${ISO_TIMESTAMP} hello$`),
      ),
    );
  });

  it('suppresses a message below the configured level', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLogLevel(LogLevel.WARN);

    getLogger().debug('x');
    getLogger().info('y');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();

    getLogger().warn('z');

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to INFO', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    getLogger().debug('x');
    getLogger().info('y');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('routes each level to its matching console method', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel(LogLevel.DEBUG);

    getLogger().debug('d');
    getLogger().info('i');
    getLogger().warn('w');
    getLogger().error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEBUG: [ADK] '),
    );
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('INFO: [ADK] '),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARN: [ADK] '),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ERROR: [ADK] '),
    );
  });

  it('joins arguments with a single space', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setLogLevel(LogLevel.INFO);

    getLogger().info('a', 1, true);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^INFO: \\[ADK\\] ${ISO_TIMESTAMP} a 1 true$`),
      ),
    );
  });

  it('log() emits without throwing', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setLogLevel(LogLevel.INFO);

    expect(() => getLogger().log(LogLevel.INFO, 'via log')).not.toThrow();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('via log'));
  });

  it('formats the full line for a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLogLevel(LogLevel.WARN);

    getLogger().warn('boom');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^WARN: \\[ADK\\] ${ISO_TIMESTAMP} boom$`),
      ),
    );
  });
});

describe('browser safety', () => {
  it('keeps the browser-reachable logger free of imports', async () => {
    const source = await readCoreSource('logger.ts');

    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it('keeps winston in the Node-only logger', async () => {
    const source = await readCoreSource('logger_node.ts');

    expect(source).toMatch(/from 'winston'/);
  });
});
