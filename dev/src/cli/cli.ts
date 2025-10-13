#! /usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'os';
import * as path from 'path';
import dotenv from 'dotenv';
import {Command, Argument, Option} from 'commander';
import {LogLevel, setLogLevel} from '@google/adk';
import {AdkWebServer} from '../server/adk_web_server.js';
import {runAgent} from './cli_run.js';

dotenv.config();

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  'debug': LogLevel.DEBUG,
  'info': LogLevel.INFO,
  'warn': LogLevel.WARN,
  'error': LogLevel.ERROR,
};

function getLogLevelFromOptions(
    options: {verbose?: boolean; log_level?: string;}) {
  if (options.verbose) {
    return LogLevel.DEBUG;
  }

  if (typeof options.log_level === 'string') {
    return LOG_LEVEL_MAP[options.log_level.toLowerCase()] || LogLevel.INFO;
  }

  return LogLevel.INFO;
}

function getAbsolutePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

const AGENT_DIR_ARGUMENT =
    new Argument(
        '[agents_dir]',
        'Agent file or directory of agents to serve. For directory the internal structure should be agents_dir/{agentName}.js or agents_dir/{agentName}/agent.js. Agent file should has export of the rootAgent as instance of BaseAgent (e.g LlmAgent)')
        .default(process.cwd());
const HOST_OPTION =
    new Option(
        '-h, --host <string>', 'Optional. The binding host of the server')
        .default(os.hostname());
const PORT_OPTION =
    new Option('-p, --port <number>', 'Optional. The port of the server')
        .default('8000');
const ORIGINS_OPTION =
    new Option(
        '--allow_origins <string>', 'Optional. The allow origins of the server')
        .default('');
const VERBOSE_OPTION =
    new Option(
        '-v, --verbose [boolean]', 'Optional. The verbose level of the server')
        .default(false);
const LOG_LEVEL_OPTION =
    new Option('--log_level <string>', 'Optional. The log level of the server')
        .default('info');

const program = new Command('ADK CLI');

program.command('web')
    .description('Start ADK web server')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .action((agentsDir: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        agentsDir: getAbsolutePath(agentsDir),
        host: options['host'],
        port: parseInt(options['port'], 10),
        serveDebugUI: true,
        allowOrigins: options['allow_origins'],
      });

      server.start();
    });

program.command('api_server')
    .description('Start ADK API server')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .action((agentsDir: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        agentsDir: getAbsolutePath(agentsDir),
        host: options['host'],
        port: parseInt(options['port'], 10),
        serveDebugUI: false,
        allowOrigins: options['allow_origins'],
      });

      server.start();
    });

program.command('run')
    .description('Runs agent')
    .argument('<agent>', 'Agent file path (.js or .ts)')
    .option(
        '--save_session [boolean]',
        'Optional. Whether to save the session to a json file on exit.', false)
    .option(
        '--session_id <string>',
        'Optional. The session ID to save the session to on exit when --save_session is set to true. User will be prompted to enter a session ID if not set.')
    .option(
        '--replay <string>',
        'The json file that contains the initial state of the session and user queries. A new session will be created using this state. And user queries are run against the newly created session. Users cannot continue to interact with the agent.')
    .option(
        '--resume <string>',
        'The json file that contains a previously saved session (by --save_session option). The previous session will be re-displayed. And user can continue to interact with the agent.')
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .action((agentPath: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      runAgent({
        agentPath,
        inputFile: options['replay'],
        savedSessionFile: options['resume'],
        saveSession: !!options['save_session'],
        sessionId: options['session_id'],
      });
    });

program.parse(process.argv);