/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import * as path from 'node:path';

import {AgentLoader} from '../../utils/agent_loader.js';
import {isFile, isFolderExists} from '../../utils/file_utils.js';
import {
  BaseDeployOptions,
  CreateDockerFileContentOptions,
  copyAgentFiles,
  createDockerFile,
  createDockerFileContent,
  createPackageJson,
  resolveDefaultFromGcloudConfig,
  spawnAsync,
} from './deploy_utils.js';

export {createDockerFileContent, type CreateDockerFileContentOptions};

export interface DeployToCloudRunOptions extends BaseDeployOptions {
  serviceName: string;
  extraGcloudArgs?: string[];
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
  const agentLoader = new AgentLoader(
    options.agentPath,
    options.agentFileLoadOptions,
  );

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
      a2a: options.a2a,
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
