/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getLogger,
  LogLevel,
  resetLogger,
  setLogLevel,
} from '../../src/utils/logger.js';
import {installNodeLogger, WinstonLogger} from '../../src/utils/logger_node.js';

/** The escape character that opens an ANSI colour code. */
const ESC = String.fromCharCode(27);

/** The colour codes `winston.format.colorize()` wraps the level in. */
const ANSI_ESCAPE = new RegExp(`${ESC}\\[\\d+m`, 'g');

/**
 * Node keeps the stream behind `console` on an internal field, and winston's
 * Console transport writes straight to it. Vitest installs its own `console`,
 * so capturing the output means spying on that stream rather than on
 * `process.stdout`.
 */
type ConsoleWithStdout = typeof console & {
  _stdout?: {write(chunk: string): boolean};
};

/** Lines the Console transport wrote during the test. */
let lines: string[] = [];

/** Lets winston's stream pipeline flush before the assertions run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE, '');
}

describe('WinstonLogger', () => {
  beforeEach(() => {
    lines = [];
    const consoleWithStdout: ConsoleWithStdout = console;
    const stdout = consoleWithStdout._stdout;
    if (!stdout) {
      expect.fail('console has no _stdout stream to capture');
    }
    vi.spyOn(stdout, 'write').mockImplementation((chunk: string) => {
      lines.push(chunk);
      return true;
    });
    installNodeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it('is installed by installNodeLogger()', () => {
    expect(getLogger()).toBeInstanceOf(WinstonLogger);
  });

  it('writes the ADK line format', async () => {
    setLogLevel(LogLevel.ERROR);

    getLogger().error('boom');
    await flush();

    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]).trimEnd()).toMatch(
      /^ERROR: \[ADK\] \d{4}-\d{2}-\d{2}T[\d:.]+Z boom$/,
    );
  });

  it('colorizes the level', async () => {
    setLogLevel(LogLevel.ERROR);

    getLogger().error('boom');
    await flush();

    expect(lines[0]).toContain(`${ESC}[`);
  });

  it('suppresses the levels below the configured level', async () => {
    setLogLevel(LogLevel.WARN);

    getLogger().debug('d');
    getLogger().info('i');
    await flush();

    expect(lines).toHaveLength(0);

    getLogger().warn('w');
    getLogger().error('e');
    await flush();

    expect(lines.map((line) => stripAnsi(line).trimEnd())).toEqual([
      expect.stringMatching(/^WARN: \[ADK\] .* w$/),
      expect.stringMatching(/^ERROR: \[ADK\] .* e$/),
    ]);
  });

  it('writes a debug line when the level allows it', async () => {
    setLogLevel(LogLevel.DEBUG);

    getLogger().debug('trace');
    await flush();

    expect(stripAnsi(lines[0]).trimEnd()).toMatch(/^DEBUG: \[ADK\] .* trace$/);
  });

  it('suppresses a warning below the configured level', async () => {
    setLogLevel(LogLevel.ERROR);

    getLogger().warn('w');
    await flush();

    expect(lines).toHaveLength(0);
  });

  it('joins arguments with a single space', async () => {
    setLogLevel(LogLevel.INFO);

    getLogger().info('a', 1, true);
    await flush();

    expect(stripAnsi(lines[0]).trimEnd()).toMatch(/ a 1 true$/);
  });

  it('drops a log() call below the configured level', async () => {
    setLogLevel(LogLevel.ERROR);

    getLogger().log(LogLevel.INFO, 'quiet');
    await flush();

    expect(lines).toHaveLength(0);
  });

  it('throws from log() because winston rejects the numeric level name', () => {
    setLogLevel(LogLevel.ERROR);

    // Pre-existing behaviour, preserved by this change: `log()` passes the
    // numeric enum value to winston, which knows only the 'debug'..'error'
    // names. A separate change fixes it.
    expect(() => getLogger().log(LogLevel.ERROR, 'boom')).toThrow();
  });
});
