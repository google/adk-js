/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Log levels for the logger. */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger interface for ADK.
 */
export interface Logger {
  log(level: LogLevel, ...args: unknown[]): void;

  debug(...args: unknown[]): void;

  info(...args: unknown[]): void;

  warn(...args: unknown[]): void;

  error(...args: unknown[]): void;
}

let loggerInstance: Logger|undefined;
let logLevel = LogLevel.INFO;

/**
 * Returns the logger instance.
 */
export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new SimpleLogger();
  }

  return loggerInstance;
}

/**
 * Sets the log level for the logger.
 */
export function setLogLevel(level: LogLevel) {
  logLevel = level;
}

/**
 * Simple logger class for ADK.
 */
class SimpleLogger implements Logger {
  log(level: LogLevel, ...args: unknown[]) {
    if (level < logLevel) {
      return;
    }

    switch (level) {
      case LogLevel.DEBUG:
        this.debug(...args);
        break;
      case LogLevel.INFO:
        this.info(...args);
        break;
      case LogLevel.WARN:
        this.warn(...args);
        break;
      case LogLevel.ERROR:
        this.error(...args);
        break;
      default:
        throw new Error(`Unsupported log level: ${level}`);
    }
  }

  debug(...args: unknown[]) {
    if (logLevel > LogLevel.DEBUG) {
      return;
    }

    console.debug(getColoredPrefix(LogLevel.DEBUG), ...args);
  }

  info(...args: unknown[]) {
    if (logLevel > LogLevel.INFO) {
      return;
    }

    console.info(getColoredPrefix(LogLevel.INFO), ...args);
  }

  warn(...args: unknown[]) {
    if (logLevel > LogLevel.WARN) {
      return;
    }

    console.warn(getColoredPrefix(LogLevel.WARN), ...args);
  }

  error(...args: unknown[]) {
    if (logLevel > LogLevel.ERROR) {
      return;
    }

    console.error(getColoredPrefix(LogLevel.ERROR), ...args);
  }
}

const LOG_LEVEL_STR: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

const CONSOLE_COLOR_MAP: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[34m',  // Blue
  [LogLevel.INFO]: '\x1b[32m',   // Green
  [LogLevel.WARN]: '\x1b[33m',   // Yellow
  [LogLevel.ERROR]: '\x1b[31m',  // Red
};

const RESET_COLOR = '\x1b[0m';

function getColoredPrefix(level: LogLevel): string {
  return `${CONSOLE_COLOR_MAP[level]}[ADK ${LOG_LEVEL_STR[level]}]:${
      RESET_COLOR}`;
}