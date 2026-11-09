/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {AdkLogger} from '../../src/utils/logger.js';

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

function createLogger(level: LogLevel): AdkLogger {
  const logger = new AdkLogger({
    label: 'test',
    printFormat: (info) => `${info.level}: ${info.message}`,
  });
  logger.setLogLevel(level);
  return logger;
}

describe('AdkLogger winston level', () => {
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
  });

  afterEach(() => {
    globalThis.console = realConsole;
  });

  function written(): string {
    return stripVTControlCharacters(stdout.text + stderr.text);
  }

  it.each(LEVEL_METHODS)(
    'writes a %s record that winston does not filter',
    (method, tag) => {
      createLogger(LogLevel.DEBUG)[method](`msg-${method}`);

      expect(written()).toMatch(new RegExp(`^${tag}: msg-${method}$`, 'm'));
    },
  );

  it('leaves the class log level as the only filter', () => {
    const logger = createLogger(LogLevel.ERROR);

    logger.warn('quiet');
    expect(written()).toBe('');

    logger.error('loud');
    expect(written()).toMatch(/^ERROR: loud$/m);
  });
});
