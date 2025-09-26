#! /usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import {Command} from 'commander';
import {AdkWebServer} from '../server/adk_web_server.js';
import {LogLevel, setLogLevel} from '@google/adk';

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  'debug': LogLevel.DEBUG,
  'info': LogLevel.INFO,
  'warn': LogLevel.WARN,
  'error': LogLevel.ERROR,
};

function getLogLevelFromOptions(
    options: {verbose?: boolean; logLevel?: string;}) {
  if (options.verbose) {
    return LogLevel.DEBUG;
  }

  if (typeof options.logLevel === 'string') {
    return LOG_LEVEL_MAP[options.logLevel.toLowerCase()] || LogLevel.INFO;
  }

  return LogLevel.INFO;
}

const program = new Command('ADK CLI');

program.command('web')
    .description('Start ADK web server')
    .option(
        '-h, --host <string>', 'Optional. The binding host of the server',
        os.hostname())
    .option('-p, --port <number>', 'Optional. The port of the server', '8000')
    .option(
        '--allow-origins <string>', 'Optional. The allow origins of the server',
        '')
    .option(
        '-v, --verbose <boolean>', 'Optional. The verbose level of the server')
    .option(
        '--log-level <string>', 'Optional. The log level of the server', 'info')
    .action((options) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        host: options.host,
        port: parseInt(options.port, 10),
        serveDebugUI: true,
        allowOrigins: options.allowOrigins,
      });

      server.start();
    });

program.command('api_server')
    .description('Start ADK API server')
    .option(
        '-h, --host <string>', 'Optional. The binding host of the server',
        os.hostname())
    .option('-p, --port <number>', 'Optional. The port of the server', '8000')
    .option(
        '--allow-origins <string>', 'Optional. The allow origins of the server',
        '')
    .option(
        '-v, --verbose <boolean>', 'Optional. The verbose level of the server')
    .option(
        '--log-level <string>', 'Optional. The log level of the server', 'info')
    .action((options) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        host: options.host,
        port: parseInt(options.port, 10),
        serveDebugUI: false,
        allowOrigins: options.allowOrigins,
      });

      server.start();
    });

program.parse(process.argv);