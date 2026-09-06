/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, Logger, LogLevel, setLogger, setLogLevel} from '@google/adk';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetLogger} from '../../src/utils/logger.js';

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

/** Collects everything the winston Console transport writes. */
class CaptureStream extends Writable {
  text = '';

  override _write(
    chunk: Buffer,
    _encoding: string,
    done: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    done();
  }
}

type LevelMethod = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_METHODS: Array<[LevelMethod, string]> = [
  ['debug', 'DEBUG'],
  ['info', 'INFO'],
  ['warn', 'WARN'],
  ['error', 'ERROR'],
];

describe('default logger winston level', () => {
  let stdout: CaptureStream;
  let stderr: CaptureStream;
  let realConsole: typeof globalThis.console;

  /**
   * winston's Console transport writes through `console._stdout`, so each case
   * swaps the global console for one built over streams the test owns.
   */
  beforeEach(() => {
    stdout = new CaptureStream();
    stderr = new CaptureStream();
    realConsole = globalThis.console;
    globalThis.console = new Console(stdout, stderr);
    resetLogger();
  });

  afterEach(() => {
    globalThis.console = realConsole;
    resetLogger();
  });

  function written(): string {
    return stripVTControlCharacters(stdout.text + stderr.text);
  }

  it.each(LEVEL_METHODS)(
    'writes a %s record that winston does not filter',
    (method, tag) => {
      setLogLevel(LogLevel.DEBUG);

      getLogger()[method](`msg-${method}`);

      expect(written()).toMatch(
        new RegExp(`^${tag}: \\[ADK\\] .+ msg-${method}$`, 'm'),
      );
    },
  );

  it('leaves the class log level as the only filter', () => {
    setLogLevel(LogLevel.ERROR);
    const logger = getLogger();

    logger.warn('quiet');
    expect(written()).toBe('');

    logger.error('loud');
    expect(written()).toMatch(/^ERROR: \[ADK\] .+ loud$/m);
  });
});
