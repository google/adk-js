/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Node-only logger implementation.
 *
 * This module is the only place under `core/src` that may name `winston`.
 * `winston` needs Node built-ins, so no browser bundler can resolve it: this
 * module must never become reachable from `core/src/index_web.ts`. The Node
 * entry point (`core/src/index.ts`) wires it in through `setLogger`.
 * See https://github.com/google/adk-js/issues/611.
 */

import * as winston from 'winston';
import {Logger, LogLevel, setLogger} from './logger.js';

/**
 * The most permissive name in the level map below. `LogLevel` numbers grow with
 * severity, the inverse of winston's npm levels, so winston emits a record when
 * its number is at or below the configured one and `error` is the largest.
 * winston is left pass-through on purpose: every method gates on
 * `this.logLevel` before it reaches winston, so a lower value here would
 * double-gate and drop records the class already decided to emit.
 */
const WINSTON_PASSTHROUGH_LEVEL = 'error';

/** The default logger on Node. Writes through winston. */
export class WinstonLogger implements Logger {
  private readonly logger: winston.Logger;
  private logLevel: LogLevel = LogLevel.INFO;

  constructor() {
    this.logger = winston.createLogger({
      levels: {
        'debug': LogLevel.DEBUG,
        'info': LogLevel.INFO,
        'warn': LogLevel.WARN,
        'error': LogLevel.ERROR,
      },
      level: WINSTON_PASSTHROUGH_LEVEL,
      format: winston.format.combine(
        winston.format.label({label: 'ADK'}),
        winston.format((info) => {
          info.level = info.level.toUpperCase();
          return info;
        })(),
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf((info) => {
          return `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`;
        }),
      ),
      transports: [new winston.transports.Console()],
    });
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }

    this.logger.log(level.toString(), messages.join(' '));
  }

  debug(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.DEBUG) {
      return;
    }

    this.logger.debug(messages.join(' '));
  }

  info(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.INFO) {
      return;
    }

    this.logger.info(messages.join(' '));
  }

  warn(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.WARN) {
      return;
    }

    this.logger.warn(messages.join(' '));
  }

  error(...messages: unknown[]): void {
    if (this.logLevel > LogLevel.ERROR) {
      return;
    }

    this.logger.error(messages.join(' '));
  }
}

/** Makes the winston-backed logger the current ADK logger. */
export function installNodeLogger(): void {
  setLogger(new WinstonLogger());
}
