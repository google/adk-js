/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The browser logger implementation.
 *
 * It mirrors the Node logger (`logger_node.ts`): a dedicated `Logger` class plus
 * an `install*` function that the browser entry point (`core/src/index_web.ts`)
 * wires in through `setLogger`. It writes through `console` and colours the
 * level with a `%c` CSS directive, which browser dev consoles render (ANSI
 * escape codes, as winston emits on Node, are not rendered there).
 * See https://github.com/google/adk-js/issues/611.
 */

import {CONSOLE_METHOD, Logger, LogLevel, setLogger} from './logger.js';

/** The CSS colour each level's label is rendered with. */
const LEVEL_COLOR = {
  [LogLevel.DEBUG]: 'blue',
  [LogLevel.INFO]: 'green',
  [LogLevel.WARN]: 'orange',
  [LogLevel.ERROR]: 'red',
} as const;

/** The default logger in the browser. Writes coloured lines through `console`. */
export class BrowserLogger implements Logger {
  private logLevel: LogLevel = LogLevel.INFO;

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const rest = `: [ADK] ${timestamp} ${messages.join(' ')}`;

    console[CONSOLE_METHOD[level]](
      `%c${LogLevel[level]}%c${rest}`,
      `color: ${LEVEL_COLOR[level]}`,
      'color: inherit',
    );
  }

  debug(...messages: unknown[]): void {
    this.log(LogLevel.DEBUG, ...messages);
  }

  info(...messages: unknown[]): void {
    this.log(LogLevel.INFO, ...messages);
  }

  warn(...messages: unknown[]): void {
    this.log(LogLevel.WARN, ...messages);
  }

  error(...messages: unknown[]): void {
    this.log(LogLevel.ERROR, ...messages);
  }
}

/** Makes the colour-aware browser logger the current ADK logger. */
export function installBrowserLogger(): void {
  setLogger(new BrowserLogger());
}
