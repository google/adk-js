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

  setLogLevel(level: LogLevel): void;
}

/** Label prefixed to every line the default logger emits. */
const LOG_LABEL = 'ADK';

/** Formats a single log line as `LEVEL: [ADK] <timestamp> <message>`. */
export function formatLogLine(
  level: LogLevel,
  message: string,
  timestamp: string,
): string {
  return `${LogLevel[level]}: [${LOG_LABEL}] ${timestamp} ${message}`;
}

/**
 * The default logger. Writes through `console` so that it works unchanged in
 * Node and in the browser; see https://github.com/google/adk-js/issues/611.
 */
class SimpleLogger implements Logger {
  private logLevel: LogLevel = LogLevel.INFO;

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    const line = formatLogLine(
      level,
      messages.join(' '),
      new Date().toISOString(),
    );

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(line);
        break;
      case LogLevel.INFO:
        console.info(line);
        break;
      case LogLevel.WARN:
        console.warn(line);
        break;
      case LogLevel.ERROR:
        console.error(line);
        break;
    }
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

/**
 * A no-op logger that discards all log messages.
 */
class NoOpLogger implements Logger {
  setLogLevel(_level: LogLevel): void {}
  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
}

let currentLogger: Logger = new SimpleLogger();

/**
 * Sets a custom logger for ADK, or null to disable logging.
 */
export function setLogger(customLogger: Logger | null): void {
  currentLogger = customLogger ?? new NoOpLogger();
}

/**
 * Gets the current logger instance.
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Resets the logger to the default SimpleLogger.
 */
export function resetLogger(): void {
  currentLogger = new SimpleLogger();
}

/**
 * Sets the log level for the logger.
 */
export function setLogLevel(level: LogLevel) {
  logger.setLogLevel(level);
}

/**
 * The logger instance for ADK.
 */
export const logger: Logger = {
  setLogLevel(level: LogLevel): void {
    currentLogger.setLogLevel(level);
  },
  log(level: LogLevel, ...args: unknown[]): void {
    currentLogger.log(level, ...args);
  },
  debug(...args: unknown[]): void {
    currentLogger.debug(...args);
  },
  info(...args: unknown[]): void {
    currentLogger.info(...args);
  },
  warn(...args: unknown[]): void {
    currentLogger.warn(...args);
  },
  error(...args: unknown[]): void {
    currentLogger.error(...args);
  },
};
