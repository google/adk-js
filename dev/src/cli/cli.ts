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
    .action((options) => {
      const server = new AdkWebServer({
        host: options.host,
        port: parseInt(options.port, 10),
      });

      server.start();
    });

program.parse(process.argv);