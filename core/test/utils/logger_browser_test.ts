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
import {
  BrowserLogger,
  installBrowserLogger,
} from '../../src/utils/logger_browser.js';

/** Removes the `%c` colour directives so the rendered text can be matched. */
function stripColorDirectives(line: string): string {
  return line.replace(/%c/g, '');
}

describe('BrowserLogger', () => {
  beforeEach(() => {
    installBrowserLogger();
    setLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it('is installed by installBrowserLogger()', () => {
    expect(getLogger()).toBeInstanceOf(BrowserLogger);
  });

  it('writes the ADK line format', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel(LogLevel.ERROR);

    getLogger().error('boom');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(stripColorDirectives(errorSpy.mock.calls[0][0] as string)).toMatch(
      /^ERROR: \[ADK\] \d{4}-\d{2}-\d{2}T[\d:.]+Z boom$/,
    );
  });

  it('colorizes the level', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogLevel(LogLevel.ERROR);

    getLogger().error('boom');

    const [message, levelStyle, restStyle] = errorSpy.mock.calls[0];
    expect(message).toMatch(/^%cERROR%c/);
    expect(levelStyle).toBe('color: red');
    expect(restStyle).toBe('color: inherit');
  });

  it('routes each level to its matching console method', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    getLogger().debug('d');
    getLogger().info('i');
    getLogger().warn('w');
    getLogger().error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][1]).toBe('color: blue');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][1]).toBe('color: green');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toBe('color: orange');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][1]).toBe('color: red');
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

  it('joins arguments with a single space', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setLogLevel(LogLevel.INFO);

    getLogger().info('a', 1, true);

    expect(stripColorDirectives(infoSpy.mock.calls[0][0] as string)).toMatch(
      /^INFO: \[ADK\] \d{4}-\d{2}-\d{2}T[\d:.]+Z a 1 true$/,
    );
  });

  it('log() emits without throwing', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setLogLevel(LogLevel.INFO);

    expect(() => getLogger().log(LogLevel.INFO, 'via log')).not.toThrow();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });
});

describe('browser safety', () => {
  it('keeps winston out of the browser logger', async () => {
    const {readFile} = await import('node:fs/promises');
    const {fileURLToPath} = await import('node:url');
    const source = await readFile(
      fileURLToPath(
        new URL('../../src/utils/logger_browser.ts', import.meta.url),
      ),
      'utf8',
    );

    expect(source).not.toMatch(/from 'winston'/);
    expect(source).not.toMatch(/from 'node:/);
  });
});
