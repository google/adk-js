#! /usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import {Command} from 'commander';
import {AdkWebServer} from '../server/adk_web_server.js';

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
    .action((options) => {
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
    .action((options) => {
      const server = new AdkWebServer({
        host: options.host,
        port: parseInt(options.port, 10),
        serveDebugUI: false,
        allowOrigins: options.allowOrigins,
      });

      server.start();
    });

program.parse(process.argv);