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
import {LogLevel, setLogLevel, BaseArtifactService, GcsArtifactService} from '@google/adk';
import {AdkWebServer} from '../server/adk_web_server.js';
import {runAgent} from './cli_run.js';
import {deployToCloudRun} from './cli_deploy.js';
import {getTempDir} from '../utils/file_utils.js';
import { createAgent } from './cli_create.js';

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

function getArtifactServiceFromUri(uri: string): BaseArtifactService {
  if (uri.startsWith('gs://')) {
    const bucket = uri.split('://')[1];

    return new GcsArtifactService(bucket);
  }

  throw new Error(`Unsupported artifact service URI: ${uri}`);
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
const ARTIFACT_SERVICE_URI_OPTION = new Option(
    '--artifact_service_uri <string>, Optional. The URI of the artifact service, supported URIs: gs://<bucket name> for GCS artifact service.')

const program = new Command('ADK CLI');

program.command('web')
    .description('Start ADK web server')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .action((agentsDir: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        agentsDir: getAbsolutePath(agentsDir),
        host: options['host'],
        port: parseInt(options['port'], 10),
        serveDebugUI: true,
        allowOrigins: options['allow_origins'],
        artifactService: options['artifact_service_uri'] ?
            getArtifactServiceFromUri(options['artifact_service_uri']) :
            undefined,
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
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .action((agentsDir: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      const server = new AdkWebServer({
        agentsDir: getAbsolutePath(agentsDir),
        host: options['host'],
        port: parseInt(options['port'], 10),
        serveDebugUI: false,
        allowOrigins: options['allow_origins'],
        artifactService: options['artifact_service_uri'] ?
            getArtifactServiceFromUri(options['artifact_service_uri']) :
            undefined,
      });
    server.start();
  });

program.command('create')
    .description('Creates a new agent')
    .argument('[agent]', 'Name to give the new agent', 'adk_agent')
    .option('-y, --yes', 'Optional. Skip confirmation prompts.')
    .option('--model <string>', 'Optional. THe model used for the root_agent')
    .option(
        '--api_key <string>',
        'Optional. The API Key needed to access the model, e.g. Google AI API Key.')
    .option(
        '--project <string>',
        'Optional. The Google Cloud Project for using VertexAI as backend.')
    .option(
        '--region <string>',
        'Optional. The Google Cloud Region for using VertexAI as backend.')
    .option(
        '--language <string>',
        'Optional. Either ts or js as the language to output.')
    .action((agentName: string, options: Record<string, string>) => {
      createAgent({
        agentName,
        forceYes: !!options['yes'],
        model: options['model'],
        apiKey: options['api_key'],
        project: options['project'],
        region: options['region'],
        language: options['language'],
      });
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
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .action((agentPath: string, options: Record<string, string>) => {
      setLogLevel(getLogLevelFromOptions(options));

      runAgent({
        agentPath,
        inputFile: options['replay'],
        savedSessionFile: options['resume'],
        saveSession: !!options['save_session'],
        sessionId: options['session_id'],
        artifactService: options['artifact_service_uri'] ?
            getArtifactServiceFromUri(options['artifact_service_uri']) :
            undefined,
      });
    });

const DEPLOY_COMMAND = program.command('deploy')
                           .description('Deploy agent')
                           .allowUnknownOption()
                           .allowExcessArguments();

DEPLOY_COMMAND.command('cloud_run')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(PORT_OPTION)
    .option(
        '--project [string]',
        'Optional. Google Cloud project to deploy the agent. If not set, default project from gcloud config is used')
    .option(
        '--region [string]',
        'Optional. Google Cloud region to deploy the agent. If not set, default run/region from gcloud config is used')
    .option(
        '--service_name [string]',
        'Optional. The service name to use in Cloud Run. Default: "adk-default-service-name"',
        'adk-default-service-name')
    .option(
        '--temp_folder [string]',
        'Optional. Temp folder for the generated Cloud Run source files (default: a timestamped folder in the system temp directory).',
        getTempDir('cloud_run_deploy_src'))
    .option(
        '--adk_version [string]',
        'Optional. ADK version to use in the Cloud Run service. If not set, default to the latest version available on npm',
        'latest')
    .option(
        '--with_ui [boolean]',
        'Optional. Deploy ADK Web UI if set. (default: deploy ADK API server only)',
        false)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .action((agentPath: string, options: Record<string, string>) => {
      const extraGcloudArgs = [];
      for (const arg of process.argv.slice(5)) {
        let argName = arg.replace(/^-+/, '');
        if (argName.includes('=')) {
          argName = argName.split('=')[0];
        }
        if (argName in options) {
          continue;
        }

        extraGcloudArgs.push(arg);
      }

      deployToCloudRun({
        agentPath: getAbsolutePath(agentPath),
        project: options['project'],
        region: options['region'],
        serviceName: options['service_name'],
        tempFolder: options['temp_folder'],
        port: parseInt(options['port'], 10),
        withUi: !!options['with_ui'],
        logLevel: options['log_level'],
        adkVersion: options['adk_version'],
        allowOrigins: options['allow_origins'],
        extraGcloudArgs,
        artifactServiceUri: options['artifact_service_uri'],
      });
    });

program.parse(process.argv);