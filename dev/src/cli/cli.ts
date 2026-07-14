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
import {AdkLogger} from '../utils/logger.js';
import {version} from '../version.js';
import {createAgent} from './cli_create.js';
import {runAgent} from './cli_run.js';
import {deployToAgentEngine} from './deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from './deploy/cli_deploy_cloud_run.js';

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
  'Optional. The port of the server. Default: 8000',
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
  '--session_service_uri <string>',
  'Optional. The URI of the session service. Supported URIs: memory:// for in-memory session service.',
);
const ARTIFACT_SERVICE_URI_OPTION = new Option(
  '--artifact_service_uri <string>',
  'Optional. The URI of the artifact service. Supported URIs: gs://<bucket name> for GCS artifact service.',
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
const RELOAD_AGENTS_OPTION = new Option(
  '--reload_agents [boolean]',
  'Optional. Watch agent files for changes and automatically reload them. Default: false. To see any changes to your agent file, you need to initiate a new agent run.',
).default(false);
const AGENT_FILE_MODULE_TYPE = new Option('--file_type <string>', 'Optional. ');
AGENT_FILE_MODULE_TYPE.argChoices = [FileModuleType.CJS, FileModuleType.ESM];

// Reusable deployment CLI option constants
export const PROJECT_DEPLOY_OPTION = new Option(
  '--project [string]',
  'Optional. Google Cloud project to deploy the agent. If not set, default project from gcloud config is used',
);
export const REGION_DEPLOY_OPTION = new Option(
  '--region [string]',
  'Optional. Google Cloud region to deploy the agent. If not set, default run/region from gcloud config is used',
);
export const ADK_VERSION_OPTION = new Option(
  '--adk_version [string]',
  'Optional. ADK version to use. If not set, default to the latest version available on npm',
).default('latest');
export const WITH_UI_OPTION = new Option(
  '--with_ui [boolean]',
  'Optional. Deploy ADK Web UI if set. (default: deploy ADK API server only)',
).default(false);
export const DISPLAY_NAME_OPTION = new Option(
  '--display_name [string]',
  'Optional. The display name for the Reasoning Engine. Defaults to agent directory name.',
);
export const DESCRIPTION_OPTION = new Option(
  '--description [string]',
  'Optional. The description for the Reasoning Engine.',
);
export const REPOSITORY_DEPLOY_OPTION = new Option(
  '--repository [string]',
  'Optional. Artifact Registry repository name to push docker images. Required for agent_engine deploy.',
);
export const AGENT_ENGINE_ID_OPTION = new Option(
  '--agent_engine_id [id]',
  'Optional. ID of the Agent Engine instance to update if it exists (default: undefined, which means a new instance will be created). If project and region are set, this should be the resource ID or the full resource name (projects/.../locations/.../reasoningEngines/...).',
);

/**
 * Creates the ADK CLI program.
 * @returns The ADK CLI program.
 */
export function createProgram(): Command {
  const logger = new AdkLogger({
    label: 'ADK CLI',
    colorize: {all: true},
  });

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
    .addOption(RELOAD_AGENTS_OPTION)
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
          reloadAgents: getBoolean(options['reload_agents']),
        });

        await server.start();
      } catch (error) {
        logger.error('Error starting web server:', (error as Error).message);
        process.exit(1);
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
    .addOption(RELOAD_AGENTS_OPTION)
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
          reloadAgents: getBoolean(options['reload_agents']),
        });
        await server.start();
      } catch (error) {
        logger.error('Error starting API server:', (error as Error).message);
        process.exit(1);
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
        logger.error('Error creating agent:', (error as Error).message);
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
    .addOption(RELOAD_AGENTS_OPTION)
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
          reloadAgents: getBoolean(options['reload_agents']),
        });
      } catch (error) {
        logger.error('Error running agent:', (error as Error).message);
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
    .addOption(PROJECT_DEPLOY_OPTION)
    .addOption(REGION_DEPLOY_OPTION)
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
    .addOption(ADK_VERSION_OPTION)
    .addOption(WITH_UI_OPTION)
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
        logger.error('Error deploying agent:', (error as Error).message);
      }
    });

  const registerAgentEngineCommand = (cmd: Command) => {
    cmd
      .addArgument(AGENT_DIR_ARGUMENT)
      .allowUnknownOption()
      .allowExcessArguments()
      .addOption(PROJECT_DEPLOY_OPTION)
      .addOption(REGION_DEPLOY_OPTION)
      .addOption(DISPLAY_NAME_OPTION)
      .addOption(DESCRIPTION_OPTION)
      .addOption(REPOSITORY_DEPLOY_OPTION)
      .option(
        '--temp_folder [string]',
        'Optional. Temp folder for the generated source files (default: a timestamped folder in the system temp directory).',
        getTempDir('agent_engine_deploy_src'),
      )
      .addOption(ADK_VERSION_OPTION)
      .addOption(WITH_UI_OPTION)
      .addOption(ORIGINS_OPTION)
      .addOption(VERBOSE_OPTION)
      .addOption(LOG_LEVEL_OPTION)
      .addOption(SESSION_SERVICE_URI_OPTION)
      .addOption(ARTIFACT_SERVICE_URI_OPTION)
      .addOption(COMPILE_AGENT_FILE)
      .addOption(BUNDLE_AGENT_FILE)
      .addOption(AGENT_FILE_MODULE_TYPE)
      .addOption(A2A_OPTION)
      .addOption(AGENT_ENGINE_ID_OPTION)
      .action(async (agentPath: string, options: Record<string, string>) => {
        try {
          await deployToAgentEngine({
            agentPath: getAbsolutePath(agentPath),
            project: options['project'],
            region: options['region'],
            displayName: options['display_name'],
            description: options['description'],
            repository: options['repository'],
            tempFolder: options['temp_folder'],
            port: 8080, // Agent Engine requires fixed port of 8080
            withUi: getBoolean(options['with_ui']),
            logLevel: options['log_level'],
            adkVersion: options['adk_version'],
            allowOrigins: options['allow_origins'],
            sessionServiceUri: options['session_service_uri'],
            artifactServiceUri: options['artifact_service_uri'],
            agentFileLoadOptions: getAgentFileOptions(options),
            a2a: getBoolean(options['a2a']),
            agentEngineId: options['agent_engine_id'],
          });
        } catch (error) {
          logger.error('Error deploying agent:', (error as Error).message);
        }
      });
  };

  registerAgentEngineCommand(DEPLOY_COMMAND.command('agent_engine'));
  registerAgentEngineCommand(DEPLOY_COMMAND.command('reasoning_engine'));

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
