/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {Client} from '@google-cloud/vertexai';
import dotenv from 'dotenv';

import {AgentLoader} from '../../utils/agent_loader.js';
import {createTempDir, isFile, isFolderExists} from '../../utils/file_utils.js';
import {
  BaseDeployOptions,
  copyAgentFiles,
  createDockerFile,
  createPackageJson,
  resolveDefaultFromGcloudConfig,
  spawnAsync,
} from './deploy_utils.js';

const DEFAULT_MAX_ATTEMPTS = 30;

// Platform-managed variables injected by the Agent Engine runtime at container
// startup. Forwarding them from a local .env or deploy config would overwrite
// the runtime's own resource identity, location, or revision metadata.
const PLATFORM_INJECTED_ENV_VARS = new Set([
  'GOOGLE_CLOUD_AGENT_ENGINE_ID',
  'GOOGLE_CLOUD_AGENT_ENGINE_LOCATION',
  'GOOGLE_CLOUD_AGENT_ENGINE_REVISION_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'K_REVISION',
]);

export interface DeployToAgentEngineOptions extends BaseDeployOptions {
  displayName?: string;
  description?: string;
  stagingBucket?: string;
  repository?: string;
  agentEngineId?: string;
  minInstances?: number;
  maxInstances?: number;
  /**
   * Environment variables to set on the deployed container. They are merged
   * over the variables read from the agent directory's `.env` file.
   */
  env?: DeploymentEnv;
}

/** Environment variables as a list of entries or as a name-to-value map. */
export type DeploymentEnv =
  Array<{name: string; value: string}> | Record<string, string>;

const ENABLE_TELEMETRY_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY';
const CAPTURE_MESSAGE_CONTENT_ENV_VAR = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

async function readAgentDotenv(
  envFilePath: string,
): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(envFilePath, 'utf-8');
    console.info(`Reading environment variables from ${envFilePath}`);
    return dotenv.parse(content);
  } catch (e: unknown) {
    if ((e as {code?: string}).code === 'ENOENT') {
      return {};
    }
    throw e;
  }
}

function normalizeEnvMap(env?: DeploymentEnv): Record<string, string> {
  if (!env) {
    return {};
  }
  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const entry of env) {
      result[entry.name] = entry.value;
    }
    return result;
  }
  return {...env};
}

interface ResolveDeploymentEnvParams {
  /** Variables read from the agent directory's `.env` file. */
  dotenvVars: Record<string, string>;
  /** Variables passed by the caller. They take precedence over `.env`. */
  callerEnv?: DeploymentEnv;
  /** Whether `--otel_to_cloud` was explicitly passed. */
  otelToCloud: boolean;
  /** Path of the `.env` file, used in notices. */
  envFilePath: string;
}

interface ResolvedDeploymentEnv {
  /** Environment variables for the Reasoning Engine deployment spec. */
  env: Array<{name: string; value: string}>;
  /** Whether the server exports telemetry to Google Cloud. */
  otelToCloud: boolean;
}

/**
 * Resolves the deployment environment variables and the telemetry setting.
 *
 * If `otelToCloud` is true, sets `GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY`
 * to `true` and defaults `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` to `false`
 * unless it is already set. Otherwise, a value of `true` or `1` for
 * `GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY` turns telemetry on. Variables
 * that the Agent Engine runtime injects are dropped.
 *
 * Notices name variables only and never print their values.
 */
function resolveDeploymentEnv(
  params: ResolveDeploymentEnvParams,
): ResolvedDeploymentEnv {
  const envVars = {
    ...params.dotenvVars,
    ...normalizeEnvMap(params.callerEnv),
  };

  for (const name of Object.keys(envVars)) {
    if (PLATFORM_INJECTED_ENV_VARS.has(name)) {
      console.warn(
        `Ignoring ${name} in the deployment environment as the Agent Engine runtime sets it.`,
      );
      delete envVars[name];
    }
  }

  let otelToCloud = params.otelToCloud;
  if (otelToCloud) {
    if (ENABLE_TELEMETRY_ENV_VAR in params.dotenvVars) {
      console.warn(
        `Ignoring ${ENABLE_TELEMETRY_ENV_VAR} in .env as \`--otel_to_cloud\` was explicitly passed and takes precedence`,
      );
    }
    envVars[ENABLE_TELEMETRY_ENV_VAR] = 'true';
    if (!(CAPTURE_MESSAGE_CONTENT_ENV_VAR in envVars)) {
      envVars[CAPTURE_MESSAGE_CONTENT_ENV_VAR] = 'false';
    }
  } else if (['true', '1'].includes(envVars[ENABLE_TELEMETRY_ENV_VAR])) {
    otelToCloud = true;
    console.info(
      `\`--otel_to_cloud\` is set to true by ${ENABLE_TELEMETRY_ENV_VAR} in ${params.envFilePath}`,
    );
  }

  return {
    env: Object.entries(envVars).map(([name, value]) => ({name, value})),
    otelToCloud,
  };
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

  const envFilePath = path.join(agentDir, '.env');
  const {env, otelToCloud} = resolveDeploymentEnv({
    dotenvVars: await readAgentDotenv(envFilePath),
    callerEnv: options.env,
    otelToCloud: Boolean(options.otelToCloud),
    envFilePath,
  });

  console.info('Starting deployment to Agent Engine...');

  const tempFolder =
    options.tempFolder ?? (await createTempDir('agent_engine_deploy_src'));

  if (options.tempFolder && (await isFolderExists(tempFolder))) {
    await fs.rm(tempFolder, {recursive: true, force: true});
  }

  try {
    await fs.mkdir(tempFolder, {recursive: true});

    console.info('Copying agent source files...');
    await copyAgentFiles(agentLoader, path.join(tempFolder, 'agents', appName));

    console.info('Creating package.json...');
    await createPackageJson(agentDir, tempFolder);

    console.info('Creating Dockerfile...');
    await createDockerFile(tempFolder, {
      appName,
      project: options.project,
      region: options.region,
      port: options.port,
      withUi: options.withUi,
      logLevel: options.logLevel,
      allowOrigins: options.allowOrigins,
      sessionServiceUri: options.sessionServiceUri,
      artifactServiceUri: options.artifactServiceUri,
      otelToCloud,
      a2a: options.a2a,
      agentFileLoadOptions: options.agentFileLoadOptions,
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
        tempFolder,
        '--project',
        options.project,
        '--gcs-log-dir',
        logBucket,
        '--suppress-logs',
      ],
      {stdio: 'inherit'},
    );

    const client = new Client({
      project: options.project,
      location: options.region,
    });

    const config = {
      displayName,
      description: options.description,
      spec: {
        containerSpec: {
          imageUri: imageTag,
        },
        deploymentSpec: {
          containerConcurrency: 9,
          minInstances: options.minInstances ?? 1,
          maxInstances: options.maxInstances ?? 10,
          resourceLimits: {
            cpu: '1',
            memory: '2Gi',
          },
          // Omitted when empty so a deployment without variables sends the
          // same request as before.
          ...(env.length > 0 ? {env} : {}),
        },
      },
    };

    let apiResponse;
    if (options.agentEngineId) {
      console.info('Updating Reasoning Engine resource in Vertex AI...');
      const name = options.agentEngineId.startsWith('projects/')
        ? options.agentEngineId
        : `projects/${options.project}/locations/${options.region}/reasoningEngines/${options.agentEngineId}`;
      apiResponse = await client.agentEnginesInternal.updateInternal({
        name,
        config,
      });
    } else {
      console.info('Creating Reasoning Engine resource in Vertex AI...');
      apiResponse = await client.agentEnginesInternal.createInternal({
        config,
      });
    }

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
        `Reasoning Engine ${options.agentEngineId ? 'update' : 'creation'} operation ${operationName} did not complete in time.`,
      );
    }

    if (apiResponse.error) {
      throw new Error(
        `Reasoning Engine ${options.agentEngineId ? 'update' : 'creation'} failed: [Code ${apiResponse.error.code}] ${apiResponse.error.message}`,
      );
    }

    const response = apiResponse.response!;
    console.info(
      `\x1b[32mSuccessfully ${options.agentEngineId ? 'updated' : 'deployed'} Reasoning Engine: ${response.name}\x1b[0m`,
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
    await fs.rm(tempFolder, {recursive: true, force: true});
    await agentLoader.disposeAll();
    console.info('Temporary files cleaned up.');
  }
}
