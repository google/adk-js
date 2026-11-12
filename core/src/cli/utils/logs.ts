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
 * Legacy Python `logging.Formatter` template string retained for compatibility.
 *
 * @deprecated Unused by `adk-js` loggers. ADK CLI stderr and file loggers
 *     format records directly as `<ISO-8601 timestamp> - <LEVEL> - <message>`.
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
  /**
   * Timestamp suffix for the log filename. Defaults to `YYYYMMDD_HHMMSS_<pid>`.
   * If a file with the resulting name already exists, a numeric `_<n>` suffix
   * is appended; an existing file is never overwritten.
   */
  logFileTimestamp?: string;
}

/** Upper bound on numeric suffixes tried when a log filename is taken. */
const MAX_LOG_FILE_SUFFIX = 1000;

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

function hasErrorCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === code;
}

/** An open log file and the path it was created at. */
interface LogFileHandle {
  readonly logFilepath: string;
  readonly fd: number;
}

/** The log file that the current file logger writes to. */
let activeLogFile: LogFileHandle | undefined;

/** Whether the process `exit` listener that closes the log file is set. */
let exitListenerRegistered = false;

function closeActiveLogFile(): void {
  if (!activeLogFile) {
    return;
  }
  const {fd} = activeLogFile;
  activeLogFile = undefined;
  try {
    fs.closeSync(fd);
  } catch {
    // The descriptor is already closed.
  }
}

/** Returns the user ID of the process, or `undefined` on Windows. */
function getUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Returns `true` if `dir` exists and is a symlink (dangling or not) or is not
 * a directory. Returns `false` if it is a directory or cannot be inspected.
 */
function isSymlinkOrNonDirectory(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isSymbolicLink() || !stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates `dir` if it does not exist and makes sure that only the current
 * user can use it.
 *
 * @returns `false` if `dir` is a symlink, is not a directory, or (on POSIX) is
 *     owned by another user. The caller must then not use it.
 */
function preparePrivateDirectory(dir: string): boolean {
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  } catch (e: unknown) {
    // A file, a symlink to a file, or a dangling symlink at `dir` makes
    // `mkdirSync` fail with an error such as EEXIST, ENOTDIR, EACCES or ENOENT.
    // Reject such a path here. Rethrow the error for any other cause.
    if (!isSymlinkOrNonDirectory(dir)) {
      throw e;
    }
    return false;
  }

  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return false;
  }

  const uid = getUid();
  if (uid === undefined) {
    // Windows does not use POSIX permission bits.
    return true;
  }
  if (stat.uid !== uid) {
    return false;
  }

  fs.chmodSync(dir, 0o700);
  if ((fs.lstatSync(dir).mode & 0o077) !== 0) {
    throw new Error(
      `Log directory ${dir} is accessible by other users after chmod 0o700.`,
    );
  }
  return true;
}

/**
 * Returns a log directory in the system temp folder that only the current
 * user can use. If `<tmp>/<subFolder>` is a symlink, is not a directory, or is
 * owned by another user, `<tmp>/<subFolder>_<uid>` is used instead.
 */
function resolveLogDir(subFolder: string): string {
  const logDir = path.join(os.tmpdir(), subFolder);
  if (preparePrivateDirectory(logDir)) {
    return logDir;
  }

  const uid = getUid();
  if (uid === undefined) {
    throw new Error(`Log directory ${logDir} is not a directory.`);
  }
  const userLogDir = path.join(os.tmpdir(), `${subFolder}_${uid}`);
  if (preparePrivateDirectory(userLogDir)) {
    return userLogDir;
  }
  throw new Error(
    `Log directories ${logDir} and ${userLogDir} are not directories ` +
      `owned by the current user.`,
  );
}

/**
 * Creates and opens a log file that only the current user can read and write.
 * The file is created exclusively, so an existing file or symlink at the
 * target path is never truncated or followed. On a name collision, numeric
 * suffixes `_1`, `_2`, ... are tried in turn.
 *
 * @returns The path of the created file and its open file descriptor.
 */
function createExclusiveLogFile({
  logDir,
  logFilePrefix,
  logFileTimestamp,
}: {
  logDir: string;
  logFilePrefix: string;
  logFileTimestamp: string;
}): LogFileHandle {
  for (let counter = 0; counter <= MAX_LOG_FILE_SUFFIX; counter++) {
    const suffix = counter === 0 ? '' : `_${counter}`;
    const candidate = path.join(
      logDir,
      `${logFilePrefix}.${logFileTimestamp}${suffix}.log`,
    );
    try {
      // 'ax' is O_WRONLY | O_CREAT | O_EXCL | O_APPEND.
      const fd = fs.openSync(candidate, 'ax', 0o600);
      return {logFilepath: candidate, fd};
    } catch (e: unknown) {
      if (!hasErrorCode(e, 'EEXIST')) {
        throw e;
      }
    }
  }
  throw new Error(
    `Failed to create a unique log file in ${logDir} for ` +
      `${logFilePrefix}.${logFileTimestamp}`,
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
 * Closes the log file that `logToTmpFolder` opened, if any.
 *
 * @param level The minimum `LogLevel` to emit. Defaults to `LogLevel.INFO`.
 */
export function setupAdkLogger(level: LogLevel = LogLevel.INFO): void {
  closeActiveLogFile();
  setLogLevel(level);
  setLogger(
    createWriterLogger(level, (line) => {
      process.stderr.write(`${line}\n`);
    }),
  );
}

/**
 * Configures the global ADK logger to write formatted log records to a timestamped
 * file in the system temporary directory and updates the `<prefix>.latest.log`
 * symlink to point to the newest file.
 *
 * The log directory is restricted to the current user (mode `0o700`) and the
 * log file is created with mode `0o600`. If `<tmp>/<subFolder>` is a symlink,
 * is not a directory, or is owned by another user, the logs go to
 * `<tmp>/<subFolder>_<uid>` instead. Records are written through the file
 * descriptor opened at creation. The default timestamp includes the
 * process ID. If the log filename is already taken, a numeric `_<n>` suffix is
 * appended so that an existing file is never overwritten. The path of the log
 * file is printed to `stderr`.
 *
 * @param options Configuration options for the temporary log file.
 * @returns The absolute path to the created log file.
 */
export function logToTmpFolder(options: LogToTmpFolderOptions = {}): string {
  const {
    level = LogLevel.INFO,
    subFolder = 'agents_log',
    logFilePrefix = 'agent',
  } = options;
  const logFileTimestamp =
    options.logFileTimestamp ??
    `${formatDateTimestamp(new Date())}_${process.pid}`;

  const logDir = resolveLogDir(subFolder);
  const logFile = createExclusiveLogFile({
    logDir,
    logFilePrefix,
    logFileTimestamp,
  });
  const {logFilepath} = logFile;

  closeActiveLogFile();
  activeLogFile = logFile;
  if (!exitListenerRegistered) {
    process.on('exit', closeActiveLogFile);
    exitListenerRegistered = true;
  }

  setLogLevel(level);
  // Write through the open descriptor, not the path, so that a file swapped in
  // at the path after creation never receives log records.
  const fileLogger = createWriterLogger(level, (line) => {
    if (activeLogFile !== logFile) {
      return;
    }
    fs.writeSync(logFile.fd, `${line}\n`, null, 'utf-8');
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
  process.stderr.write(`Log setup complete: ${logFilepath}\n`);
  return logFilepath;
}
