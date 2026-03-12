#! /usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseSessionService,
  LogLevel,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
  setLogLevel as setAdkCoreLogLevel,
} from '@google/adk';
import {Argument, Command, Option} from 'commander';
import dotenv from 'dotenv';
import * as path from 'path';
import {runIntegrationTests} from '../integration/run_integration_tests.js';
import {AdkApiServer} from '../server/adk_api_server.js';
import {FileModuleType} from '../utils/agent_loader.js';
import {getTempDir} from '../utils/file_utils.js';
import {version} from '../version.js';
import {createAgent} from './cli_create.js';
import {deployToCloudRun} from './cli_deploy.js';
import {runAgent} from './cli_run.js';

dotenv.config({quiet: true});

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  'debug': LogLevel.DEBUG,
  'info': LogLevel.INFO,
  'warn': LogLevel.WARN,
  'error': LogLevel.ERROR,
};

function getLogLevelFromOptions(options: {
  verbose?: boolean;
  log_level?: string;
}) {
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

function getSessionServiceFromOptions(options: {
  session_service_uri?: string;
}): BaseSessionService {
  return getSessionServiceFromUri(
    options['session_service_uri'] || process.env.DATABASE_URL || 'memory://',
  );
}

function getArtifactServiceFromOptions(options: {
  artifact_service_uri?: string;
}): BaseArtifactService | undefined {
  return getArtifactServiceFromUri(
    options['artifact_service_uri'] || 'memory://',
  );
}

function getAgentFileOptions(options: {
  compile?: boolean;
  bundle?: boolean;
  file_type?: string;
}) {
  return {
    compile: getBoolean(options['compile']),
    bundle: getBoolean(options['bundle']),
    moduleType: options['file_type'] as FileModuleType | undefined,
  };
}

function getBoolean(option?: string | boolean): boolean {
  if (typeof option === 'boolean') {
    return option;
  }

  if (typeof option === 'string') {
    return option === 'true' || option === '1';
  }

  return false;
}

const AGENT_DIR_ARGUMENT = new Argument(
  '[agents_dir]',
  'Agent file or directory of agents to serve. For directory the internal structure should be agents_dir/{agentName}.js or agents_dir/{agentName}/agent.js. Agent file should has export of the rootAgent as instance of BaseAgent (e.g LlmAgent)',
).default(process.cwd());
const HOST_OPTION = new Option(
  '-h, --host <string>',
  'Optional. The binding host of the server',
).default('localhost');
const PORT_OPTION = new Option(
  '-p, --port <number>',
  'Optional. The port of the server',
).default('8000');
const ORIGINS_OPTION = new Option(
  '--allow_origins <string>',
  'Optional. The allow origins of the server',
).default('');
const VERBOSE_OPTION = new Option(
  '-v, --verbose [boolean]',
  'Optional. The verbose level of the server',
).default(false);
const LOG_LEVEL_OPTION = new Option(
  '--log_level <string>',
  'Optional. The log level of the server',
).default('info');
const SESSION_SERVICE_URI_OPTION = new Option(
  '--session_service_uri <string>, Optional. The URI of the session service. Supported URIs: memory:// for in-memory session service.',
);
const ARTIFACT_SERVICE_URI_OPTION = new Option(
  '--artifact_service_uri <string>, Optional. The URI of the artifact service. Supported URIs: gs://<bucket name> for GCS artifact service.',
);
const OTEL_TO_CLOUD_OPTION = new Option(
  '--otel_to_cloud [boolean]',
  'Optional. Whether to send otel traces to cloud.',
).default(false);
const COMPILE_AGENT_FILE = new Option(
  '--compile [boolean]',
  'Optional. Whether to compile ts agent file to js before execution',
).default(true);
const BUNDLE_AGENT_FILE = new Option(
  '--bundle [boolean]',
  'Optional. Whether to compile ts agent file to js before execution',
).default(true);
const A2A_OPTION = new Option(
  '--a2a [boolean]',
  'Optional. Whether to enable A2A for web/api server. Default: false',
).default(false);
const AGENT_FILE_MODULE_TYPE = new Option('--file_type <string>', 'Optional. ');
AGENT_FILE_MODULE_TYPE.argChoices = [FileModuleType.CJS, FileModuleType.ESM];

/**
 * Creates the ADK CLI program.
 * @returns The ADK CLI program.
 */
export function createProgram(): Command {
  const program = new Command('ADK CLI');

  program
    .addOption(new Option('-v, --version', 'Get ADK CLI version'))
    .action(() => {
      console.log(version);
    });

  program
    .command('web')
    .description('Start ADK web server')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(OTEL_TO_CLOUD_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(A2A_OPTION)
    .action(async (agentsDir: string, options: Record<string, string>) => {
      const logLevel = getLogLevelFromOptions(options);
      setAdkCoreLogLevel(logLevel);

      try {
        const server = new AdkApiServer({
          logLevel,
          agentsDir: getAbsolutePath(agentsDir),
          host: options['host'],
          port: parseInt(options['port'], 10),
          serveDebugUI: true,
          allowOrigins: options['allow_origins'],
          sessionService: getSessionServiceFromOptions(options),
          artifactService: getArtifactServiceFromOptions(options),
          otelToCloud: options['otel_to_cloud'] ? true : false,
          agentFileLoadOptions: getAgentFileOptions(options),
          a2a: getBoolean(options['a2a']),
        });

        await server.start();
      } catch (error) {
        console.error('Error starting web server:', error);
      }
    });

  program
    .command('api_server')
    .description('Start ADK API server')
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(OTEL_TO_CLOUD_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(A2A_OPTION)
    .action(async (agentsDir: string, options: Record<string, string>) => {
      const logLevel = getLogLevelFromOptions(options);
      setAdkCoreLogLevel(logLevel);

      try {
        const server = new AdkApiServer({
          logLevel,
          agentsDir: getAbsolutePath(agentsDir),
          host: options['host'],
          port: parseInt(options['port'], 10),
          serveDebugUI: false,
          allowOrigins: options['allow_origins'],
          sessionService: getSessionServiceFromOptions(options),
          artifactService: getArtifactServiceFromOptions(options),
          otelToCloud: options['otel_to_cloud'] ? true : false,
          agentFileLoadOptions: getAgentFileOptions(options),
          a2a: getBoolean(options['a2a']),
        });
        await server.start();
      } catch (error) {
        console.error('Error starting API server:', error);
      }
    });

  program
    .command('create')
    .description('Creates a new agent')
    .argument('[agent]', 'Name to give the new agent', 'adk_agent')
    .option('-y, --yes', 'Optional. Skip confirmation prompts.')
    .option('--model <string>', 'Optional. THe model used for the root_agent')
    .option(
      '--api_key <string>',
      'Optional. The API Key needed to access the model, e.g. Google AI API Key.',
    )
    .option(
      '--project <string>',
      'Optional. The Google Cloud Project for using VertexAI as backend.',
    )
    .option(
      '--region <string>',
      'Optional. The Google Cloud Region for using VertexAI as backend.',
    )
    .option(
      '--language <string>',
      'Optional. Either ts or js as the language to output.',
    )
    .action(async (agentName: string, options: Record<string, string>) => {
      try {
        await createAgent({
          agentName,
          forceYes: !!options['yes'],
          model: options['model'],
          apiKey: options['api_key'],
          project: options['project'],
          region: options['region'],
          language: options['language'],
        });
      } catch (error) {
        console.error('Error creating agent:', error);
      }
    });

  program
    .command('run')
    .description('Runs agent')
    .argument('<agent>', 'Agent file path (.js or .ts)')
    .option(
      '--save_session [boolean]',
      'Optional. Whether to save the session to a json file on exit.',
      false,
    )
    .option(
      '--session_id <string>',
      'Optional. The session ID to save the session to on exit when --save_session is set to true. User will be prompted to enter a session ID if not set.',
    )
    .option(
      '--replay <string>',
      'The json file that contains the initial state of the session and user queries. A new session will be created using this state. And user queries are run against the newly created session. Users cannot continue to interact with the agent.',
    )
    .option(
      '--resume <string>',
      'The json file that contains a previously saved session (by --save_session option). The previous session will be re-displayed. And user can continue to interact with the agent.',
    )
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(OTEL_TO_CLOUD_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .action(async (agentPath: string, options: Record<string, string>) => {
      setAdkCoreLogLevel(getLogLevelFromOptions(options));

      try {
        await runAgent({
          agentPath,
          inputFile: options['replay'],
          savedSessionFile: options['resume'],
          saveSession: getBoolean(options['save_session']),
          sessionId: options['session_id'],
          sessionService: getSessionServiceFromOptions(options),
          artifactService: getArtifactServiceFromOptions(options),
          otelToCloud: options['otel_to_cloud'] ? true : false,
          agentFileLoadOptions: getAgentFileOptions(options),
        });
      } catch (error) {
        console.error('Error running agent:', error);
      }
    });

  const DEPLOY_COMMAND = program
    .command('deploy')
    .description('Deploy agent')
    .allowUnknownOption()
    .allowExcessArguments();

  DEPLOY_COMMAND.command('cloud_run')
    .addArgument(AGENT_DIR_ARGUMENT)
    .allowUnknownOption()
    .allowExcessArguments()
    .addOption(PORT_OPTION)
    .option(
      '--project [string]',
      'Optional. Google Cloud project to deploy the agent. If not set, default project from gcloud config is used',
    )
    .option(
      '--region [string]',
      'Optional. Google Cloud region to deploy the agent. If not set, default run/region from gcloud config is used',
    )
    .option(
      '--service_name [string]',
      'Optional. The service name to use in Cloud Run. Default: "adk-default-service-name"',
      'adk-default-service-name',
    )
    .option(
      '--temp_folder [string]',
      'Optional. Temp folder for the generated Cloud Run source files (default: a timestamped folder in the system temp directory).',
      getTempDir('cloud_run_deploy_src'),
    )
    .option(
      '--adk_version [string]',
      'Optional. ADK version to use in the Cloud Run service. If not set, default to the latest version available on npm',
      'latest',
    )
    .option(
      '--with_ui [boolean]',
      'Optional. Deploy ADK Web UI if set. (default: deploy ADK API server only)',
      false,
    )
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(A2A_OPTION)
    .action(async (agentPath: string, options: Record<string, string>) => {
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

      try {
        await deployToCloudRun({
          agentPath: getAbsolutePath(agentPath),
          project: options['project'],
          region: options['region'],
          serviceName: options['service_name'],
          tempFolder: options['temp_folder'],
          port: parseInt(options['port'], 10),
          withUi: getBoolean(options['with_ui']),
          logLevel: options['log_level'],
          adkVersion: options['adk_version'],
          allowOrigins: options['allow_origins'],
          sessionServiceUri: options['session_service_uri'],
          artifactServiceUri: options['artifact_service_uri'],
          agentFileLoadOptions: getAgentFileOptions(options),
          a2a: getBoolean(options['a2a']),
          extraGcloudArgs,
        });
      } catch (error) {
        console.error('Error deploying agent:', error);
      }
    });

  const CONFORMANCE_COMMAND = program
    .command('integration')
    .description('Run ADK integration and conformance tests');

  CONFORMANCE_COMMAND.command('conformance')
    .description('Run ADK conformance tests')
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .option(
      '--agents_dir [dir]',
      'Directory of conformance test agent definitions. Recursively searched for .yaml files with agent definitions.',
      process.cwd(),
    )
    .option(
      '--tests_dir [dir]',
      'Directory of conformance test definitions. Recursively searched for .yaml files with test definitions.',
      process.cwd(),
    )
    .option('--force', 'Force run skipped tests.')
    .action(async (options: Record<string, string>) => {
      runIntegrationTests({
        agentsDir: options['agents_dir'],
        testsDir: options['tests_dir'],
        forceRunAll: getBoolean(options['force']),
      });
    });

  return program;
}
