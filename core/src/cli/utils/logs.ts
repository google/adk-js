/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';

import {Logger, LogLevel, setLogger, setLogLevel} from '../../utils/logger.js';

/**
 * Standard log format template for CLI log output.
 */
export const LOGGING_FORMAT =
  '%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s';

/**
 * Options for configuring `logToTmpFolder`.
 */
export interface LogToTmpFolderOptions {
  /** Minimum log level to record. Defaults to `LogLevel.INFO`. */
  level?: LogLevel;
  /** Subdirectory inside the system temp folder. Defaults to `'agents_log'`. */
  subFolder?: string;
  /** Prefix for generated log files. Defaults to `'agent'`. */
  logFilePrefix?: string;
  /** Timestamp suffix for the log filename. Defaults to `YYYYMMDD_HHMMSS`. */
  logFileTimestamp?: string;
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARNING',
  [LogLevel.ERROR]: 'ERROR',
};

function formatDateTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function formatLogLine(level: LogLevel, messages: unknown[]): string {
  const iso = new Date().toISOString();
  const levelName = LOG_LEVEL_NAMES[level] ?? 'INFO';
  const formattedMessage = messages
    .map((m) => (typeof m === 'string' ? m : util.inspect(m, {depth: null})))
    .join(' ');
  return `${iso} - ${levelName} - ${formattedMessage}`;
}

function createWriterLogger(
  initialLevel: LogLevel,
  writeLine: (line: string) => void,
): Logger {
  let currentLevel = initialLevel;

  const logAt = (targetLevel: LogLevel, messages: unknown[]): void => {
    if (currentLevel <= targetLevel) {
      writeLine(formatLogLine(targetLevel, messages));
    }
  };

  return {
    setLogLevel(level: LogLevel): void {
      currentLevel = level;
    },
    log(level: LogLevel, ...messages: unknown[]): void {
      logAt(level, messages);
    },
    debug(...messages: unknown[]): void {
      logAt(LogLevel.DEBUG, messages);
    },
    info(...messages: unknown[]): void {
      logAt(LogLevel.INFO, messages);
    },
    warn(...messages: unknown[]): void {
      logAt(LogLevel.WARN, messages);
    },
    error(...messages: unknown[]): void {
      logAt(LogLevel.ERROR, messages);
    },
  };
}

/**
 * Configures the global ADK logger to write formatted log records to `stderr`.
 *
 * @param level The minimum `LogLevel` to emit. Defaults to `LogLevel.INFO`.
 */
export function logToStderr(level: LogLevel = LogLevel.INFO): void {
  setLogLevel(level);
  setLogger(
    createWriterLogger(level, (line) => {
      process.stderr.write(`${line}\n`);
    }),
  );
}

/**
 * Configures the global ADK logger to write formatted log records to `stderr`.
 *
 * @param level The minimum `LogLevel` to emit. Defaults to `LogLevel.INFO`.
 */
export function setupAdkLogger(level: LogLevel = LogLevel.INFO): void {
  logToStderr(level);
}

/**
 * Configures the global ADK logger to write formatted log records to a timestamped
 * file in the system temporary directory and updates the `<prefix>.latest.log`
 * symlink to point to the newest file.
 *
 * @param options Configuration options for the temporary log file.
 * @returns The absolute path to the created log file.
 */
export function logToTmpFolder(options: LogToTmpFolderOptions = {}): string {
  const {
    level = LogLevel.INFO,
    subFolder = 'agents_log',
    logFilePrefix = 'agent',
    logFileTimestamp = formatDateTimestamp(new Date()),
  } = options;

  const logDir = path.join(os.tmpdir(), subFolder);
  fs.mkdirSync(logDir, {recursive: true});

  const logFilename = `${logFilePrefix}.${logFileTimestamp}.log`;
  const logFilepath = path.join(logDir, logFilename);

  fs.writeFileSync(logFilepath, '', 'utf-8');

  setLogLevel(level);
  const fileLogger = createWriterLogger(level, (line) => {
    fs.appendFileSync(logFilepath, `${line}\n`, 'utf-8');
  });
  setLogger(fileLogger);

  const latestLogLink = path.join(logDir, `${logFilePrefix}.latest.log`);
  try {
    try {
      fs.lstatSync(latestLogLink);
      fs.unlinkSync(latestLogLink);
    } catch {
      // Symlink does not exist yet.
    }
    fs.symlinkSync(logFilepath, latestLogLink);
  } catch (e: unknown) {
    fileLogger.warn(`Failed to create symlink to latest log: ${String(e)}`);
  }

  fileLogger.info(`Log setup complete: ${logFilepath}`);
  return logFilepath;
}
