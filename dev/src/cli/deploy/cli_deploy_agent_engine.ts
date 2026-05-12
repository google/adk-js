/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {ReasoningEngine as VertexReasoningEngine} from '@google-cloud/vertexai/build/src/genai/types.js';

import {AgentFileOptions, AgentLoader} from '../../utils/agent_loader.js';
import {isFile, isFolderExists, saveToFile} from '../../utils/file_utils.js';
import {
  copyAgentFiles,
  createPackageJson,
  resolveDefaultFromGcloudConfig,
  spawnAsync,
} from './deploy_utils.js';

const DEFAULT_MAX_ATTEMPTS = 30;

export interface DeployToAgentEngineOptions {
  agentPath: string;
  project?: string;
  region?: string;
  displayName?: string;
  description?: string;
  tempFolder: string;
  adkVersion: string;
  port: number;
  withUi: boolean;
  logLevel: string;
  allowOrigins?: string;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  agentFileLoadOptions?: AgentFileOptions;
  a2a?: boolean;
  stagingBucket?: string;
}

export function createDockerFileContent(options: {
  appName: string;
  project: string;
  region: string;
  port: number;
  withUi: boolean;
  logLevel: string;
  allowOrigins?: string;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  a2a?: boolean;
}): string {
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

  if (options.sessionServiceUri) {
    adkServerOptions.push(`--session_service_uri=${options.sessionServiceUri}`);
  }

  if (options.a2a) {
    adkServerOptions.push('--a2a');
  }

  return `
FROM node:lts-alpine
WORKDIR /app

# Create a non-root user
RUN adduser --disabled-password --gecos "" myuser

# Switch to the non-root user
USER myuser

# Set up environment variables
ENV PATH="/home/myuser/.local/bin:$PATH"
ENV GOOGLE_GENAI_USE_VERTEXAI=1
ENV GOOGLE_CLOUD_PROJECT=${options.project}
ENV GOOGLE_CLOUD_LOCATION=${options.region}

# Copy application files
COPY --chown=myuser:myuser "agents/${options.appName}/" "/app/agents/${
    options.appName
  }/"
COPY --chown=myuser:myuser "package.json" "/app/package.json"
COPY --chown=myuser:myuser "package-lock.json" "/app/package-lock.json"
COPY --chown=myuser:myuser "node_modules" "/app/node_modules"

# Install Agent Deps
RUN npm install @google/adk-devtools@latest
RUN npm install --production

EXPOSE ${options.port}

CMD npx adk ${adkCommand} /app/agents/${options.appName} ${adkServerOptions.join(
    ' ',
  )}`;
}

async function createDockerFile(
  targetFolder: string,
  options: {
    appName: string;
    project: string;
    region: string;
    port: number;
    withUi: boolean;
    logLevel: string;
    allowOrigins?: string;
    sessionServiceUri?: string;
    artifactServiceUri?: string;
    a2a?: boolean;
  },
) {
  const dockerFilePath = path.join(targetFolder, 'Dockerfile');
  await saveToFile(dockerFilePath, createDockerFileContent(options));
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

    console.info('Building and pushing container image using Cloud Builds...');
    const imageTag = `gcr.io/${options.project}/agent-engine-${appName}:latest`;
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
