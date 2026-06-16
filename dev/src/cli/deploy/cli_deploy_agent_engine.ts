/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {ReasoningEngine as VertexReasoningEngine} from '@google-cloud/vertexai/build/src/genai/types.js';

import {AgentLoader} from '../../utils/agent_loader.js';
import {isFile, isFolderExists} from '../../utils/file_utils.js';
import {
  BaseDeployOptions,
  copyAgentFiles,
  createDockerFile,
  createPackageJson,
  resolveDefaultFromGcloudConfig,
  spawnAsync,
} from './deploy_utils.js';

const DEFAULT_MAX_ATTEMPTS = 30;

export interface DeployToAgentEngineOptions extends BaseDeployOptions {
  displayName?: string;
  description?: string;
  stagingBucket?: string;
  repository?: string;
}

export async function deployToAgentEngine(options: DeployToAgentEngineOptions) {
  const project =
    options.project || (await resolveDefaultFromGcloudConfig('project'));
  if (!project || project === '(unset)') {
    throw new Error(
      'Project is not specified and default value for "project" is not set in gcloud config.',
    );
  }
  if (!options.project) {
    options.project = project;
  }

  const region =
    options.region || (await resolveDefaultFromGcloudConfig('run/region'));
  if (!region) {
    throw new Error(
      'Region is not specified and default value for "run/region" is not set in gcloud config.',
    );
  }
  if (!options.region) {
    options.region = region;
  }

  if (!options.repository) {
    throw new Error(
      `Artifact Registry repository is not specified.\n` +
        `Please create a Docker repository in Artifact Registry first and specify it using the --repository flag.\n` +
        `To create a repository, run:\n` +
        `  gcloud artifacts repositories create <repository-name> --repository-format=docker --location=${options.region} --project=${options.project}`,
    );
  }

  const agentLoader = new AgentLoader(
    options.agentPath,
    options.agentFileLoadOptions,
  );

  const isFileProvided = await isFile(options.agentPath);
  const agentDir = isFileProvided
    ? path.dirname(options.agentPath)
    : options.agentPath;
  const appName = isFileProvided
    ? path.parse(options.agentPath).name
    : path.basename(options.agentPath);

  const displayName = options.displayName || appName;

  console.info('Starting deployment to Agent Engine...');

  if (await isFolderExists(options.tempFolder)) {
    await fs.rm(options.tempFolder, {recursive: true, force: true});
  }

  try {
    await fs.mkdir(options.tempFolder, {recursive: true});

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
      sessionServiceUri: options.sessionServiceUri,
      artifactServiceUri: options.artifactServiceUri,
      a2a: options.a2a,
    });

    const imageTag = `${options.region}-docker.pkg.dev/${options.project}/${options.repository}/agent-engine-${appName}:latest`;
    console.info(
      `Building and pushing container image to ${imageTag} using Cloud Builds...`,
    );
    const logBucket = options.stagingBucket
      ? `gs://${options.stagingBucket}/logs`
      : `gs://${options.project}_cloudbuild/logs`;

    await spawnAsync(
      'gcloud',
      [
        'builds',
        'submit',
        '--tag',
        imageTag,
        options.tempFolder,
        '--project',
        options.project,
        '--gcs-log-dir',
        logBucket,
        '--suppress-logs',
      ],
      {stdio: 'inherit'},
    );

    console.info('Creating Reasoning Engine resource in Vertex AI...');
    const client = new Client({
      project: options.project,
      location: options.region,
    });

    let apiResponse = await client.agentEnginesInternal.createInternal({
      config: {
        displayName,
        description: options.description,
        spec: {
          containerSpec: {
            imageUri: imageTag,
          },
          deploymentSpec: {
            containerConcurrency: 9,
            minInstances: 1,
            maxInstances: 10,
            resourceLimits: {
              cpu: '1',
              memory: '2Gi',
            },
          },
        },
      },
    });

    const operationName = apiResponse.name!;
    console.info(`Waiting for operation ${operationName} to complete...`);

    let attempts = 0;
    while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
      const [nextResponse] = await Promise.all([
        client.agentEnginesInternal.getAgentOperationInternal({
          operationName,
        }),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      apiResponse = nextResponse;
      attempts++;
    }

    if (!apiResponse.done) {
      throw new Error(
        `Reasoning Engine creation operation ${operationName} did not complete in time.`,
      );
    }

    if (apiResponse.error) {
      throw new Error(
        `Reasoning Engine creation failed: [Code ${apiResponse.error.code}] ${apiResponse.error.message}`,
      );
    }

    const response = apiResponse.response as VertexReasoningEngine;
    console.info(
      `\x1b[32mSuccessfully deployed Reasoning Engine: ${response.name}\x1b[0m`,
    );
  } catch (e: unknown) {
    console.error(
      '\x1b[31mFailed to deploy to Agent Engine:',
      (e as Error).message,
      '\x1b[0m',
    );
    throw e;
  } finally {
    console.info('Cleaning up temporary files...');
    await fs.rm(options.tempFolder, {recursive: true, force: true});
    await agentLoader.disposeAll();
    console.info('Temporary files cleaned up.');
  }
}
