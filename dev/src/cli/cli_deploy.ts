/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';

import {AgentFileBundleMode, AgentLoader} from '../utils/agent_loader.js';
import {
  isFile,
  isFolderExists,
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../utils/file_utils.js';

const execAsync = promisify(exec);
const spawnAsync = promisify(spawn);

const REQUIRED_NPM_PACKAGES = ['@google/adk'];

export interface CreateDockerFileContentOptions {
  appName?: string;
  project: string;
  region?: string;
  port: number;
  withUi: boolean;
  logLevel: string;
  allowOrigins?: string;
  artifactServiceUri?: string;
  otelToCloud?: boolean;
}

export interface DeployToCloudRunOptions extends CreateDockerFileContentOptions {
  agentPath: string;
  serviceName: string;
  tempFolder: string;
  adkVersion: string;
  extraGcloudArgs?: string[];
  otelToCloud?: boolean;
}

function validateGcloudExtraArgs(
  extraGcloudArgs: string[],
  adkManagedArgs: string[],
) {
  const userArgNames = new Set<string>();
  for (const arg of extraGcloudArgs) {
    if (arg.startsWith('--')) {
      const argName = arg.split('=')[0];
      userArgNames.add(argName);
    }
  }

  const conflicts = adkManagedArgs
    .filter((arg) => userArgNames.has(arg))
    .sort();
  if (conflicts.length) {
    throw new Error(
      `The argument(s) ${conflicts.join(
        ', ',
      )} conflict with ADK's automatic configuration. ADK will set these arguments automatically, so please remove them from your command.`,
    );
  }
}

async function copyAgentFiles(
  agentLoader: AgentLoader,
  targetPath: string,
): Promise<void> {
  const agentNames = await agentLoader.listAgents();

  for (const agentName of agentNames) {
    const agentFile = await agentLoader.getAgentFile(agentName);
    const fileName = path.parse(agentFile.getFilePath()).base;

    await fs.cp(agentFile.getFilePath(), path.join(targetPath, fileName));
  }
}

function prepareGCloudArguments(options: DeployToCloudRunOptions): string[] {
  const regionOptions: string[] = options.region
    ? ['--region', options.region]
    : [];
  const adkManagedArgs = ['--source', '--project', '--port', '--verbosity'];
  if (options.region) {
    adkManagedArgs.push('--region');
  }

  if (options.extraGcloudArgs) {
    validateGcloudExtraArgs(options.extraGcloudArgs, adkManagedArgs);
  }

  const gcloudCommands: string[] = [
    'run',
    'deploy',
    options.serviceName,
    '--source',
    options.tempFolder,
    '--project',
    options.project,
    ...regionOptions,
    '--port',
    options.port.toString(),
    '--verbosity',
    options.logLevel.toLowerCase(),
  ];

  const userLabels = [];
  const extraArgsWithoutLabels = [];
  if (options.extraGcloudArgs?.length) {
    for (const arg of options.extraGcloudArgs) {
      if (arg === '--labels') {
        userLabels.push(arg.slice(9));
      } else {
        extraArgsWithoutLabels.push(arg);
      }
    }
  }

  const allLabels = ['created-by=adk', ...userLabels];
  gcloudCommands.push('--labels', allLabels.join(','));
  gcloudCommands.push(...extraArgsWithoutLabels);

  return gcloudCommands;
}

async function createPackageJson(sourceFolder: string, targetFolder: string) {
  const packageJsonPath = await tryToFindFileRecursively(
    sourceFolder,
    'package.json',
    3,
  );
  const packageJson = await loadFileData<{
    dependencies: Record<string, string>;
  }>(packageJsonPath);
  if (!packageJson || !packageJson.dependencies) {
    throw new Error(
      `No dependencies found in package.json: ${packageJsonPath}`,
    );
  }
  for (const requiredDep of REQUIRED_NPM_PACKAGES) {
    if (!(requiredDep in packageJson.dependencies)) {
      throw new Error(
        `Package "${requiredDep}" is required but not found in package.json: ${
          packageJsonPath
        }`,
      );
    }
  }

  const targetPackageJsonPath = path.join(targetFolder, 'package.json');

  await Promise.all([
    fs.mkdir(path.join(targetFolder, 'node_modules')),
    saveToFile(path.join(targetFolder, 'package-lock.json'), ''),
    saveToFile(targetPackageJsonPath, {
      dependencies: packageJson.dependencies,
    }),
  ]);
  console.info('Creating package.json complete', targetPackageJsonPath);
}

function createDockerFileContent(
  options: CreateDockerFileContentOptions,
): string {
  const adkCommand = options.withUi ? 'web' : 'api_server';
  const adkServerOptions = [`--port=${options.port}`, '--host=0.0.0.0'];

  if (options.logLevel) {
    adkServerOptions.push(`--log_level=${options.logLevel}`);
  }

  if (options.allowOrigins) {
    adkServerOptions.push(`--allow_origins=${options.allowOrigins}`);
  }

  if (options.artifactServiceUri) {
    adkServerOptions.push(
      `--artifact_service_uri=${options.artifactServiceUri}`,
    );
  }

  if (options.otelToCloud) {
    adkServerOptions.push('--otel_to_cloud');
  }

  return `
FROM node:lts-alpine
WORKDIR /app

# Create a non-root user
RUN adduser --disabled-password --gecos "" myuser

# Switch to the non-root user
USER myuser

# Set up environment variables - Start
ENV PATH="/home/myuser/.local/bin:$PATH"
ENV GOOGLE_GENAI_USE_VERTEXAI=1
ENV GOOGLE_CLOUD_PROJECT=${options.project}
ENV GOOGLE_CLOUD_LOCATION=${options.region}
# Set up environment variables - End

# Copy application files
COPY --chown=myuser:myuser "agents/${options.appName}/" "/app/agents/${
    options.appName
  }/"
COPY --chown=myuser:myuser "package.json" "/app/package.json"
COPY --chown=myuser:myuser "package-lock.json" "/app/package-lock.json"
COPY --chown=myuser:myuser "node_modules" "/app/node_modules"
# Copy application files

# Install Agent Deps - Start
RUN npm install @google/adk-devtools@latest
RUN npm install --production
# Install Agent Deps - End

EXPOSE ${options.port}

CMD npx adk ${adkCommand} /app/agents/${options.appName} ${adkServerOptions.join(
    ' ',
  )}`;
}

async function resolveDefaultFromGcloudConfig(
  property: string,
): Promise<string | undefined> {
  const {stdout} = await execAsync('gcloud config get-value ' + property);
  return stdout.trim();
}

async function createDockerFile(
  targetFolder: string,
  options: CreateDockerFileContentOptions,
) {
  const dockerFilePath = path.join(targetFolder, 'Dockerfile');
  await saveToFile(dockerFilePath, createDockerFileContent(options));

  console.info('Creating Dockerfile complete:', dockerFilePath);
}

export async function deployToCloudRun(options: DeployToCloudRunOptions) {
  const project =
    options.project || (await resolveDefaultFromGcloudConfig('project'));
  if (!project || project === '(unset)') {
    throw new Error(
      'Project is not specified and default value for "project" is not set in gcloud config. Please specify region with --project option or set default value running "gcloud config set project YOUR_PROJECT".',
    );
  }
  if (!options.project) {
    options.project = project;
    console.info(
      '--project option is not provided, using default project from gcloud config:',
      project,
    );
  }

  const region =
    options.region || (await resolveDefaultFromGcloudConfig('run/region'));
  if (!region) {
    throw new Error(
      'Region is not specified and default value for "run/region" is not set in gcloud config. Please specify region with --region option or set default value running "gcloud config set run/region YOUR_REGION".',
    );
  }
  if (!options.region) {
    options.region = region;
    console.info(
      '--region option is not provided, using default region from gcloud config:',
      region,
    );
  }

  const gcloudCommands = prepareGCloudArguments(options);

  // Request to bundle any js or ts file into a single cjs file to be able to
  // copy file with all it's dependencies correctly.
  const agentLoader = new AgentLoader(options.agentPath, {
    bundle: AgentFileBundleMode.ANY,
  });

  const isFileProvided = await isFile(options.agentPath);
  const agentDir = isFileProvided
    ? path.dirname(options.agentPath)
    : options.agentPath;
  const appName =
    options.appName || isFileProvided
      ? path.parse(options.agentPath).name
      : path.basename(options.agentPath);

  console.info('Starting deployment to Cloud Run...');

  if (await isFolderExists(options.tempFolder)) {
    console.info('Cleaning up existing temporary files...');
    await fs.rm(options.tempFolder, {recursive: true, force: true});
  }

  try {
    console.info('Copying agent source files...');
    await copyAgentFiles(
      agentLoader,
      path.join(options.tempFolder, 'agents', appName),
    );

    console.info('Creating package.json...');
    await createPackageJson(agentDir, options.tempFolder);

    console.info('Creating Dockerfile...');
    await createDockerFile(options.tempFolder, {
      appName,
      project: options.project,
      region: options.region,
      port: options.port,
      withUi: options.withUi,
      logLevel: options.logLevel,
      allowOrigins: options.allowOrigins,
      otelToCloud: options.otelToCloud,
    });

    console.info('Deploying to Cloud Run...');
    await spawnAsync('gcloud', gcloudCommands, {stdio: 'inherit'});
  } catch (e: unknown) {
    console.error(
      '\x1b[31mFailed to deploy to Cloud Run:',
      (e as Error).message,
      '\x1b[0m',
    );
  } finally {
    console.info('Cleaning up temporary files...');
    await fs.rm(options.tempFolder, {recursive: true, force: true});
    await agentLoader.disposeAll();
    console.info('Temporary files cleaned up.');
  }
}
