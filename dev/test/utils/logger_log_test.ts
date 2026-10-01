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

describe('AdkLogger.log', () => {
  let stdout: CaptureStream;
  let stderr: CaptureStream;
  let realConsole: typeof globalThis.console;

  beforeEach(() => {
    stdout = new CaptureStream();
    stderr = new CaptureStream();
    realConsole = globalThis.console;
    globalThis.console = new Console(stdout, stderr);
  });

  afterEach(() => {
    globalThis.console = realConsole;
  });

  it('maps numeric log levels to winston level names', async () => {
    const logger = new AdkLogger({
      label: 'test',
      printFormat: (info) => `${info.level}: ${info.message}`,
    });
    logger.setLogLevel(LogLevel.DEBUG);

    const records: Array<[LogLevel, string]> = [
      [LogLevel.DEBUG, 'DEBUG'],
      [LogLevel.INFO, 'INFO'],
      [LogLevel.WARN, 'WARN'],
      [LogLevel.ERROR, 'ERROR'],
    ];
    for (const [level, message] of records) {
      logger.log(level, `msg-${message.toLowerCase()}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    const output = stripVTControlCharacters(stdout.text + stderr.text)
      .replace(/\r\n/g, '\n')
      .trim();
    expect(output).toBe(
      records
        .map(([, level]) => `${level}: msg-${level.toLowerCase()}`)
        .join('\n'),
    );
  });
});
