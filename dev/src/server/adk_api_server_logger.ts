/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {LogLevel, Logger} from '@google/adk';
import * as winston from 'winston';

/**
 * Logger implementation for the ADK API Server.
 */
export class ApiServerLogger implements Logger {
  private readonly logger: winston.Logger;
  private logLevel: LogLevel = LogLevel.INFO;

  constructor(label: string) {
    this.logger = winston.createLogger({
      levels: {
        'debug': LogLevel.DEBUG,
        'info': LogLevel.INFO,
        'warn': LogLevel.WARN,
        'error': LogLevel.ERROR,
      },
      format: winston.format.combine(
        winston.format.label({label}),
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

  setLogLevel(level: LogLevel) {
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
