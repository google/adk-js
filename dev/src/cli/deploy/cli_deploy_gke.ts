/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {AgentLoader} from '../../utils/agent_loader.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  saveToFile,
} from '../../utils/file_utils.js';
import {AdkLogger} from '../../utils/logger.js';
import {version} from '../../version.js';
import {
  assertSafeDockerfileToken,
  assertSafeNpmVersion,
  type BaseDeployOptions,
  copyAgentFiles,
  createDockerFileContent,
  createPackageJson,
  resolveDefaultFromGcloudConfig,
  spawnAsync,
} from './deploy_utils.js';

/**
 * Supported Kubernetes `Service` types for GKE agent deployments.
 */
export const GKE_SERVICE_TYPES = [
  'ClusterIP',
  'NodePort',
  'LoadBalancer',
] as const;

/**
 * Kubernetes `Service` type accepted by {@link deployToGke} and
 * {@link createGkeDeploymentManifest}.
 */
export type GkeServiceType = (typeof GKE_SERVICE_TYPES)[number];

/**
 * Options for {@link createGkeDeploymentManifest}.
 */
export interface CreateGkeDeploymentManifestOptions {
  readonly serviceName: string;
  readonly imageName: string;
  readonly port: number;
  readonly project: string;
  readonly region?: string;
  readonly adkVersion?: string;
  readonly serviceType?: GkeServiceType;
}

/**
 * Options for {@link deployToGke}.
 */
export interface DeployToGkeOptions extends BaseDeployOptions {
  clusterName: string;
  serviceName: string;
  serviceType?: GkeServiceType;
}

const GKE_SERVICE_PORT = 80;
const K8S_MAX_LABEL_VALUE_LENGTH = 63;
const K8S_DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SAFE_CLUSTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_IMAGE_NAME_RE = /^[A-Za-z0-9_./:-]{1,256}$/;

function assertValidClusterName(
  clusterName: string | undefined,
): asserts clusterName is string {
  const normalized = clusterName ?? '';
  if (!SAFE_CLUSTER_NAME_RE.test(normalized)) {
    throw new Error(
      `Invalid clusterName ${JSON.stringify(normalized)}: must be a non-empty cluster identifier matching ${SAFE_CLUSTER_NAME_RE}.`,
    );
  }
}

function assertValidK8sServiceName(serviceName: string): void {
  if (!K8S_DNS_LABEL_RE.test(serviceName)) {
    throw new Error(
      `Invalid serviceName ${JSON.stringify(serviceName)}: must be a valid RFC 1123 DNS label matching ${K8S_DNS_LABEL_RE}.`,
    );
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port ${JSON.stringify(port)}: must be an integer between 1 and 65535.`,
    );
  }
}

function isGkeServiceType(value: string): value is GkeServiceType {
  return (GKE_SERVICE_TYPES as readonly string[]).includes(value);
}

function assertValidServiceType(
  serviceType: string,
): asserts serviceType is GkeServiceType {
  if (!isGkeServiceType(serviceType)) {
    throw new Error(
      `Invalid serviceType ${JSON.stringify(serviceType)}: must be one of ${GKE_SERVICE_TYPES.join(', ')}.`,
    );
  }
}

function assertSafeImageName(imageName: string): void {
  if (!SAFE_IMAGE_NAME_RE.test(imageName)) {
    throw new Error(
      `Invalid imageName ${JSON.stringify(imageName)}: must match ${SAFE_IMAGE_NAME_RE}.`,
    );
  }
}

function formatImageTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}`
  );
}

/**
 * Normalizes an npm version, range, or dist-tag into a valid Kubernetes label
 * value (`<= 63` characters with alphanumeric endpoints), or `''` when no
 * alphanumeric characters remain.
 */
function sanitizeK8sVersionLabel(adkVersion: string): string {
  return adkVersion
    .replace(/^[~^]+/, '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, K8S_MAX_LABEL_VALUE_LENGTH)
    .replace(/^[-_.]+|[-_.]+$/g, '');
}

/**
 * Generates a Kubernetes `Deployment` and `Service` YAML manifest for GKE.
 */
export function createGkeDeploymentManifest(
  options: CreateGkeDeploymentManifestOptions,
): string {
  assertValidK8sServiceName(options.serviceName);
  assertValidPort(options.port);
  assertSafeDockerfileToken(options.project, 'project');
  if (options.region !== undefined && options.region !== '') {
    assertSafeDockerfileToken(options.region, 'region');
  }
  const adkVersion = options.adkVersion ?? version;
  assertSafeNpmVersion(adkVersion);
  const sanitizedVersion = sanitizeK8sVersionLabel(adkVersion);
  const serviceType = options.serviceType ?? 'ClusterIP';
  assertValidServiceType(serviceType);
  assertSafeImageName(options.imageName);

  const deploymentLabels = [
    '    app.kubernetes.io/name: "adk-agent"',
    ...(sanitizedVersion
      ? [`    app.kubernetes.io/version: ${JSON.stringify(sanitizedVersion)}`]
      : []),
    `    app.kubernetes.io/instance: ${JSON.stringify(options.serviceName)}`,
    '    app.kubernetes.io/managed-by: "adk-cli"',
  ];
  const podTemplateLabels = [
    `        app: ${JSON.stringify(options.serviceName)}`,
    '        app.kubernetes.io/name: "adk-agent"',
    ...(sanitizedVersion
      ? [
          `        app.kubernetes.io/version: ${JSON.stringify(sanitizedVersion)}`,
        ]
      : []),
    `        app.kubernetes.io/instance: ${JSON.stringify(options.serviceName)}`,
    '        app.kubernetes.io/managed-by: "adk-cli"',
  ];

  const envEntries = [
    '        - name: GOOGLE_GENAI_USE_ENTERPRISE\n          value: "1"',
    `        - name: GOOGLE_CLOUD_PROJECT\n          value: ${JSON.stringify(options.project)}`,
  ];
  if (options.region) {
    envEntries.push(
      `        - name: GOOGLE_CLOUD_LOCATION\n          value: ${JSON.stringify(options.region)}`,
    );
  }

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${JSON.stringify(options.serviceName)}
  labels:
${deploymentLabels.join('\n')}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${JSON.stringify(options.serviceName)}
  template:
    metadata:
      labels:
${podTemplateLabels.join('\n')}
    spec:
      containers:
      - name: ${JSON.stringify(options.serviceName)}
        image: ${JSON.stringify(options.imageName)}
        ports:
        - containerPort: ${options.port}
        env:
${envEntries.join('\n')}
---
apiVersion: v1
kind: Service
metadata:
  name: ${JSON.stringify(options.serviceName)}
spec:
  type: ${JSON.stringify(serviceType)}
  selector:
    app: ${JSON.stringify(options.serviceName)}
  ports:
  - port: ${GKE_SERVICE_PORT}
    targetPort: ${options.port}
`;
}

/**
 * Stages bundled agent sources, builds a container image via Cloud Build, and
 * applies a Kubernetes Deployment and Service to a GKE cluster.
 */
export async function deployToGke(options: DeployToGkeOptions): Promise<void> {
  const logger = new AdkLogger({
    label: 'ADK GKE Deploy',
    colorize: {all: true},
  });
  if (options.logLevel?.toLowerCase() === 'debug') {
    logger.setLogLevel(LogLevel.DEBUG);
  }

  assertValidClusterName(options.clusterName);
  assertValidK8sServiceName(options.serviceName);
  const serviceType = options.serviceType ?? 'ClusterIP';
  assertValidServiceType(serviceType);
  assertValidPort(options.port);

  const region = options.region || undefined;
  if (region !== undefined) {
    assertSafeDockerfileToken(region, 'region');
  }

  if (options.project) {
    assertSafeDockerfileToken(options.project, 'project');
  }
  const project =
    options.project || (await resolveDefaultFromGcloudConfig('project'));
  if (!project || project === '(unset)') {
    throw new Error(
      'Project is not specified and default value for "project" is not set in gcloud config. Please specify project with --project option or set default value running "gcloud config set project YOUR_PROJECT".',
    );
  }
  assertSafeDockerfileToken(project, 'project');
  if (!options.project) {
    logger.info(
      `--project option is not provided, using default project from gcloud config: ${project}`,
    );
  }

  const normalizedAgentPath =
    options.agentPath.replace(/[\\/]+$/, '') || options.agentPath;
  const isFileProvided = await isFile(normalizedAgentPath);
  const agentDir = isFileProvided
    ? path.dirname(normalizedAgentPath)
    : normalizedAgentPath;
  const appName =
    options.appName ||
    (isFileProvided
      ? path.parse(normalizedAgentPath).name
      : path.basename(normalizedAgentPath));
  assertSafeDockerfileToken(appName, 'appName');

  const adkVersion = options.adkVersion ?? version;
  assertSafeNpmVersion(adkVersion);

  const dockerfileContent = createDockerFileContent({
    appName,
    project,
    region,
    port: options.port,
    withUi: options.withUi,
    logLevel: options.logLevel,
    allowOrigins: options.allowOrigins,
    sessionServiceUri: options.sessionServiceUri,
    artifactServiceUri: options.artifactServiceUri,
    memoryServiceUri: options.memoryServiceUri,
    otelToCloud: options.otelToCloud,
    a2a: options.a2a,
    agentFileLoadOptions: options.agentFileLoadOptions,
    adkVersion,
  });

  const imageTag = formatImageTimestamp(new Date());
  const imageName = `gcr.io/${project}/${options.serviceName}:${imageTag}`;
  const deploymentManifest = createGkeDeploymentManifest({
    serviceName: options.serviceName,
    imageName,
    port: options.port,
    project,
    region,
    adkVersion,
    serviceType,
  });

  if (options.withUi) {
    logger.warn(
      'ADK Web is for development purposes. It has access to all data and should not be used in production.',
    );
  }
  if (options.a2a) {
    logger.warn(
      'SECURITY WARNING: deploying the A2A surface WITHOUT authentication, ' +
        'so any caller that can reach the service can invoke the agent and ' +
        'its tools.',
    );
  }

  logger.info('Starting deployment to GKE...');

  const agentLoader = new AgentLoader(
    normalizedAgentPath,
    options.agentFileLoadOptions,
  );
  const tempFolder =
    options.tempFolder ?? (await createTempDir('gke_deploy_src'));

  if (options.tempFolder && (await isFolderExists(tempFolder))) {
    logger.debug('Cleaning up existing temporary files...');
    await fs.rm(tempFolder, {recursive: true, force: true});
  }

  try {
    await fs.mkdir(tempFolder, {recursive: true});

    logger.debug('Copying agent source files...');
    await copyAgentFiles(agentLoader, path.join(tempFolder, 'agents', appName));

    logger.debug('Creating package.json...');
    await createPackageJson(agentDir, tempFolder);

    logger.debug('Creating Dockerfile...');
    await saveToFile(path.join(tempFolder, 'Dockerfile'), dockerfileContent);

    logger.debug(`Building container image ${imageName} with Cloud Build...`);
    await spawnAsync(
      'gcloud',
      [
        'builds',
        'submit',
        '--tag',
        imageName,
        '--project',
        project,
        '--verbosity',
        options.logLevel.toLowerCase(),
        tempFolder,
      ],
      {stdio: 'inherit'},
    );

    const deploymentYamlPath = path.join(tempFolder, 'deployment.yaml');
    logger.debug(`Writing Kubernetes manifest to ${deploymentYamlPath}...`);
    await saveToFile(deploymentYamlPath, deploymentManifest);

    logger.debug('Fetching GKE cluster credentials...');
    await spawnAsync(
      'gcloud',
      [
        'container',
        'clusters',
        'get-credentials',
        options.clusterName,
        ...(region ? ['--region', region] : []),
        '--project',
        project,
      ],
      {stdio: 'inherit'},
    );

    logger.debug('Applying Kubernetes manifest...');
    await spawnAsync('kubectl', ['apply', '-f', deploymentYamlPath], {
      stdio: 'inherit',
    });

    logger.info('Deployment to GKE finished successfully.');
    if (serviceType === 'ClusterIP') {
      logger.info(
        `The service is only reachable from within the cluster. To access it locally, run:\n` +
          `  kubectl port-forward svc/${options.serviceName} ${options.port}:${GKE_SERVICE_PORT}\n` +
          `To expose the service externally, add a Gateway or re-deploy with --service_type=LoadBalancer.`,
      );
    }
  } finally {
    logger.debug('Cleaning up temporary files...');
    await Promise.allSettled([
      fs.rm(tempFolder, {recursive: true, force: true}),
      agentLoader.disposeAll(),
    ]);
  }
}
