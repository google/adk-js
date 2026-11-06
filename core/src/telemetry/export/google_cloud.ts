/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LogAttributes} from '@opentelemetry/api-logs';
import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {
  defaultResource,
  detectResources,
  emptyResource,
  envDetector,
  Resource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  BatchLogRecordProcessorOptions,
  LogRecordExporter,
  ReadWriteLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InstrumentType,
  PeriodicExportingMetricReader,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ReadableSpan,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';

import {logger} from '../../utils/logger.js';
import {version} from '../../version.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_TELEMETRY_TRACES_ENDPOINT =
  'https://telemetry.googleapis.com/v1/traces';
const DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/traces';

const DEFAULT_TELEMETRY_METRICS_ENDPOINT =
  'https://telemetry.googleapis.com/v1/metrics';
const DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/metrics';

const DEFAULT_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.googleapis.com/v1/logs';
const DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/logs';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

const GCP_DEFAULT_LOG_NAME = 'GCP_DEFAULT_LOG_NAME';
const ADK_OTEL = 'adk-otel';
const DEFAULT_AGENT_ENGINE_LOG_NAME =
  'aiplatform.googleapis.com/reasoning_engine_stdout';

const GCP_LOG_NAME = 'gcp.log_name';
const EVENT_NAME = 'event.name';
const GCP_RESOURCE_TYPE = 'gcp.resource_type';
const LOCATION = 'location';
const REASONING_ENGINE_ID = 'reasoning_engine_id';
const RESOURCE_CONTAINER = 'resource_container';
const SERVICE_VERSION = 'service.version';

const POD_NAME_HASHES = /-[a-z0-9]+-[a-z0-9]{5}$/;
const K8S_NAMESPACE_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

const PROJECT_CACHE_SIZE = 32;

/**
 * Resolved project identifiers from the Cloud Resource Manager API.
 */
export interface ProjectInfo {
  readonly id: string;
  readonly number: string;
}

const projectCache = new Map<string, ProjectInfo>();

/**
 * Clears the cached project identifiers.
 */
export function clearProjectCache(): void {
  projectCache.clear();
}

/**
 * Normalizes headers returned by GoogleAuth into a plain string map.
 */
function normalizeHeaders(
  headers?: Headers | Record<string, string>,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (typeof (headers as Headers).forEach === 'function') {
    const result: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return {...(headers as Record<string, string>)};
}

/**
 * Returns whether client certificate authentication is enabled for mTLS.
 */
function useClientCertEffective(): boolean {
  const useClientCertStr = (
    process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE ?? 'false'
  ).toLowerCase();
  if (useClientCertStr !== 'true' && useClientCertStr !== 'false') {
    logger.warn(
      'Environment variable `GOOGLE_API_USE_CLIENT_CERTIFICATE` must be either `true` or `false`',
    );
  }
  return useClientCertStr === 'true';
}

/**
 * Selects standard or mTLS endpoint based on environment settings.
 */
export function getTelemetryEndpoint(
  defaultEndpoint: string,
  mtlsEndpoint: string,
): string {
  const useMtlsEndpointStr = (
    process.env.GOOGLE_API_USE_MTLS_ENDPOINT ?? 'auto'
  ).toLowerCase();
  let useMtlsEndpoint: 'auto' | 'always' | 'never' = 'auto';
  if (
    useMtlsEndpointStr === 'auto' ||
    useMtlsEndpointStr === 'always' ||
    useMtlsEndpointStr === 'never'
  ) {
    useMtlsEndpoint = useMtlsEndpointStr;
  } else {
    logger.warn(
      'Environment variable `GOOGLE_API_USE_MTLS_ENDPOINT` must be one of ["auto", "always", "never"]. Defaulting to auto.',
    );
    useMtlsEndpoint = 'auto';
  }

  if (useMtlsEndpoint === 'always') {
    return mtlsEndpoint;
  }
  if (useMtlsEndpoint === 'never') {
    return defaultEndpoint;
  }
  if (useClientCertEffective()) {
    return mtlsEndpoint;
  }
  return defaultEndpoint;
}

/**
 * Returns the Vertex Agent Engine User-Agent header when telemetry is enabled.
 */
export function getAgentEngineUserAgentHeader(): Record<string, string> {
  if (!process.env.GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY) {
    return {};
  }
  return {
    'User-Agent': `Vertex-Agent-Engine/${version}`,
  };
}

/**
 * Authenticated OTLP trace exporter wrapper sending spans to Google Cloud.
 */
export class AuthenticatedTraceExporter implements SpanExporter {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;
  private readonly userAgentHeaders: Record<string, string>;
  private readonly delegate: OTLPTraceExporter;
  private currentHeaders: Record<string, string> = {};
  private warnedAuthFailure = false;

  constructor(
    auth: GoogleAuth,
    endpoint: string,
    userAgentHeaders: Record<string, string> = {},
  ) {
    this.auth = auth;
    this.endpoint = endpoint;
    this.userAgentHeaders = userAgentHeaders;
    this.delegate = new OTLPTraceExporter({
      url: endpoint,
      headers: async () => this.currentHeaders,
    });
  }

  /**
   * Exports spans to Google Cloud.
   *
   * @param spans Spans to export.
   * @param resultCallback Callback called with the export result.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): void {
    void this.exportAsync(spans, resultCallback);
  }

  private async exportAsync(
    spans: ReadableSpan[],
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): Promise<void> {
    try {
      const authHeaders = await this.auth.getRequestHeaders(this.endpoint);
      this.currentHeaders = {
        ...normalizeHeaders(authHeaders),
        ...this.userAgentHeaders,
      };
    } catch (error: unknown) {
      if (!this.warnedAuthFailure) {
        this.warnedAuthFailure = true;
        logger.warn(
          'Failed to obtain Google Cloud credentials for telemetry export.',
          {error},
        );
      }
      resultCallback({
        code: 1,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    this.delegate.export(spans, resultCallback);
  }

  /**
   * Shuts down the trace exporter.
   */
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  /**
   * Flushes pending traces.
   */
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}

/**
 * Authenticated OTLP metric exporter wrapper sending metrics to Google Cloud.
 */
export class AuthenticatedMetricExporter implements PushMetricExporter {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;
  private readonly userAgentHeaders: Record<string, string>;
  private readonly delegate: OTLPMetricExporter;
  private currentHeaders: Record<string, string> = {};
  private warnedAuthFailure = false;

  constructor(
    auth: GoogleAuth,
    endpoint: string,
    userAgentHeaders: Record<string, string> = {},
  ) {
    this.auth = auth;
    this.endpoint = endpoint;
    this.userAgentHeaders = userAgentHeaders;
    this.delegate = new OTLPMetricExporter({
      url: endpoint,
      headers: async () => this.currentHeaders,
    });
  }

  /**
   * Exports metrics to Google Cloud.
   *
   * @param metrics Metrics to export.
   * @param resultCallback Callback called with the export result.
   */
  export(
    metrics: ResourceMetrics,
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): void {
    void this.exportAsync(metrics, resultCallback);
  }

  private async exportAsync(
    metrics: ResourceMetrics,
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): Promise<void> {
    try {
      const authHeaders = await this.auth.getRequestHeaders(this.endpoint);
      this.currentHeaders = {
        ...normalizeHeaders(authHeaders),
        ...this.userAgentHeaders,
      };
    } catch (error: unknown) {
      if (!this.warnedAuthFailure) {
        this.warnedAuthFailure = true;
        logger.warn(
          'Failed to obtain Google Cloud credentials for telemetry export.',
          {error},
        );
      }
      resultCallback({
        code: 1,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    this.delegate.export(metrics, resultCallback);
  }

  /**
   * Shuts down the metric exporter.
   */
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  /**
   * Flushes pending metrics.
   */
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  /**
   * Selects aggregation temporality for instrument type.
   *
   * @param instrumentType Instrument type.
   */
  selectAggregationTemporality(
    instrumentType: InstrumentType,
  ): AggregationTemporality {
    return this.delegate.selectAggregationTemporality(instrumentType);
  }
}

/**
 * Authenticated OTLP log exporter wrapper sending logs to Google Cloud.
 */
export class AuthenticatedLogExporter implements LogRecordExporter {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;
  private readonly userAgentHeaders: Record<string, string>;
  private readonly delegate: OTLPLogExporter;
  private currentHeaders: Record<string, string> = {};
  private warnedAuthFailure = false;

  constructor(
    auth: GoogleAuth,
    endpoint: string,
    userAgentHeaders: Record<string, string> = {},
  ) {
    this.auth = auth;
    this.endpoint = endpoint;
    this.userAgentHeaders = userAgentHeaders;
    this.delegate = new OTLPLogExporter({
      url: endpoint,
      headers: async () => this.currentHeaders,
    });
  }

  /**
   * Exports log records to Google Cloud.
   *
   * @param logs Log records to export.
   * @param resultCallback Callback called with the export result.
   */
  export(
    logs: ReadWriteLogRecord[],
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): void {
    void this.exportAsync(logs, resultCallback);
  }

  private async exportAsync(
    logs: ReadWriteLogRecord[],
    resultCallback: (result: {code: number; error?: Error}) => void,
  ): Promise<void> {
    try {
      const authHeaders = await this.auth.getRequestHeaders(this.endpoint);
      this.currentHeaders = {
        ...normalizeHeaders(authHeaders),
        ...this.userAgentHeaders,
      };
    } catch (error: unknown) {
      if (!this.warnedAuthFailure) {
        this.warnedAuthFailure = true;
        logger.warn(
          'Failed to obtain Google Cloud credentials for telemetry export.',
          {error},
        );
      }
      resultCallback({
        code: 1,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    this.delegate.export(logs, resultCallback);
  }

  /**
   * Shuts down the log exporter.
   */
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  /**
   * Flushes pending log records.
   */
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}

/**
 * Returns monitored resource hints needed by Cloud Logging on Agent Engine.
 */
function agentEngineLogResource(projectId: string): Resource {
  const agentEngineId = process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID;
  if (!agentEngineId) {
    return emptyResource();
  }
  const location =
    process.env.GOOGLE_CLOUD_AGENT_ENGINE_LOCATION ||
    process.env.GOOGLE_CLOUD_LOCATION ||
    '';
  return resourceFromAttributes({
    [GCP_RESOURCE_TYPE]: 'aiplatform.googleapis.com/ReasoningEngine',
    [LOCATION]: location,
    [REASONING_ENGINE_ID]: agentEngineId,
    [RESOURCE_CONTAINER]: `projects/${projectId}`,
  });
}

/**
 * Options for configuring {@link GCPBatchLogRecordProcessor}.
 */
export interface GCPBatchLogRecordProcessorOptions extends Partial<BatchLogRecordProcessorOptions> {
  readonly exporter: LogRecordExporter;
  readonly projectId?: string;
}

/**
 * Batching log processor keeping Cloud Logging log names and labels stable.
 */
export class GCPBatchLogRecordProcessor extends BatchLogRecordProcessor {
  private readonly defaultLogName: string;
  private readonly logResource: Resource;

  constructor(
    exporterOrOptions: LogRecordExporter | GCPBatchLogRecordProcessorOptions,
    projectId?: string,
  ) {
    const options: BatchLogRecordProcessorOptions =
      'export' in exporterOrOptions
        ? {exporter: exporterOrOptions}
        : exporterOrOptions;
    super(options);

    const effectiveProjectId =
      projectId ??
      ('projectId' in exporterOrOptions
        ? exporterOrOptions.projectId
        : undefined) ??
      '';
    this.logResource = agentEngineLogResource(effectiveProjectId);

    const defaultLogNameEnv = process.env[GCP_DEFAULT_LOG_NAME]?.trim();
    this.defaultLogName =
      defaultLogNameEnv && defaultLogNameEnv.length > 0
        ? defaultLogNameEnv
        : process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID
          ? DEFAULT_AGENT_ENGINE_LOG_NAME
          : ADK_OTEL;
  }

  override onEmit(logRecord: ReadWriteLogRecord): void {
    const attributes: Record<string, unknown> = {...logRecord.attributes};
    if (logRecord.eventName) {
      attributes[EVENT_NAME] = attributes[EVENT_NAME] ?? logRecord.eventName;
    }
    attributes[GCP_LOG_NAME] = attributes[GCP_LOG_NAME] ?? this.defaultLogName;

    const baseResource = logRecord.resource ?? emptyResource();
    const mergedResource = baseResource.merge(this.logResource);

    const serviceVersion = mergedResource.attributes[SERVICE_VERSION];
    if (serviceVersion !== undefined) {
      attributes[SERVICE_VERSION] =
        attributes[SERVICE_VERSION] ?? serviceVersion;
    }

    const emitted: ReadWriteLogRecord = Object.create(
      Object.getPrototypeOf(logRecord),
      {
        ...Object.getOwnPropertyDescriptors(logRecord),
        resource: {
          value: mergedResource,
          writable: true,
          enumerable: true,
          configurable: true,
        },
        attributes: {
          value: attributes as unknown as LogAttributes,
          writable: true,
          enumerable: true,
          configurable: true,
        },
        ...(process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID && logRecord.eventName
          ? {
              eventName: {
                value: undefined,
                writable: true,
                enumerable: true,
                configurable: true,
              },
              _eventName: {
                value: undefined,
                writable: true,
                enumerable: false,
                configurable: true,
              },
            }
          : {}),
      },
    );

    super.onEmit(emitted);
  }
}

/**
 * Looks up project number and ID via Cloud Resource Manager API with in-memory caching.
 *
 * Successful lookups require the `resourcemanager.projects.get` permission.
 *
 * @param project The project ID or number to query.
 * @param auth Optional GoogleAuth instance to use.
 * @returns Resolved project identifiers, or empty strings if resolution fails.
 */
export async function fetchProject(
  project?: string,
  auth?: GoogleAuth,
): Promise<ProjectInfo> {
  if (!project) {
    return {id: '', number: ''};
  }
  const cached = projectCache.get(project);
  if (cached) {
    return cached;
  }

  const isDigits = /^\d+$/.test(project);
  const known: ProjectInfo = {
    id: isDigits ? '' : project,
    number: '',
  };

  try {
    const authClient =
      auth ??
      new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    const url = `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(project)}`;
    const response = await authClient.request<{
      name?: string;
      projectId?: string;
    }>({
      url,
    });
    const data = response.data;
    const projectNumber = data?.name
      ? data.name.replace(/^projects\//, '')
      : '';
    const projectId = data?.projectId ?? (isDigits ? '' : project);
    const resolved: ProjectInfo = {
      id: projectId,
      number: projectNumber,
    };

    if (projectCache.size >= PROJECT_CACHE_SIZE) {
      const firstKey = projectCache.keys().next().value;
      if (firstKey !== undefined) {
        projectCache.delete(firstKey);
      }
    }
    projectCache.set(project, resolved);
    return resolved;
  } catch (error: unknown) {
    logger.warn(
      "Failed to look up the project's other identifier. Your traces and logs may not be associated, and the agent URN may be incomplete. To fix this, ensure the Cloud Resource Manager API is enabled with the 'resourcemanager.projects.get' permission.",
      {error},
    );
    return known;
  }
}

/**
 * Resolves the GCP project ID from parameter, environment, or Application Default Credentials.
 *
 * @param auth Optional GoogleAuth instance to use for resolution.
 * @returns The resolved project ID, or undefined if it cannot be determined.
 */
export async function getGcpProjectId(
  auth?: GoogleAuth,
): Promise<string | undefined> {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT;
  }
  try {
    const authClient =
      auth ??
      new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    const projectId = await authClient.getProjectId();
    return projectId || undefined;
  } catch {
    return undefined;
  }
}

function k8sNamespace(): string {
  try {
    return fs.readFileSync(K8S_NAMESPACE_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function k8sDeployment(): string {
  const hostname = process.env.HOSTNAME ?? '';
  if (POD_NAME_HASHES.test(hostname)) {
    return hostname.replace(POD_NAME_HASHES, '');
  }
  return '';
}

function urnAgentRuntimeSegment(): string {
  const agentEngineId = process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID;
  if (!agentEngineId) {
    logger.warn(
      'The Agent Runtime instance ID is unknown, so no agent URN is set.',
    );
    return '';
  }
  return `aiplatform:reasoningEngines:${agentEngineId}`;
}

function urnGkeSegment(attributes: Record<string, unknown>): string {
  const cluster = (attributes['k8s.cluster.name'] as string) || '';
  const namespace =
    (attributes['k8s.namespace.name'] as string) || k8sNamespace();
  const deployment =
    (attributes['k8s.deployment.name'] as string) || k8sDeployment();

  if (!cluster) {
    logger.warn(
      'The GKE cluster is unknown, so no agent URN is set. Set k8s.cluster.name in OTEL_RESOURCE_ATTRIBUTES to state it.',
    );
  }
  if (!namespace) {
    logger.warn(
      'The GKE namespace is unknown, so no agent URN is set. Set k8s.namespace.name in OTEL_RESOURCE_ATTRIBUTES to state it.',
    );
  }
  if (!deployment) {
    logger.warn(
      'The GKE Deployment is unknown, so no agent URN is set. Set k8s.deployment.name in OTEL_RESOURCE_ATTRIBUTES to state it.',
    );
  }

  if (!cluster || !namespace || !deployment) {
    return '';
  }

  return `container:clusters:${cluster}:k8s:namespaces:${namespace}:apps:deployments:${deployment}`;
}

function urnCloudRunSegment(attributes: Record<string, unknown>): string {
  const service = (attributes['faas.name'] as string) || '';
  if (!service) {
    logger.warn(
      'The Cloud Run service name is unknown, so no agent URN is set.',
    );
    return '';
  }
  return `run:services:${service}`;
}

function urnWorkloadSegment(
  attributes: Record<string, unknown>,
): string | null {
  const platform = attributes['cloud.platform'];
  if (platform === 'gcp.agent_engine') {
    return urnAgentRuntimeSegment();
  }
  if (platform === 'gcp_kubernetes_engine') {
    return urnGkeSegment(attributes);
  }
  if (platform === 'gcp_cloud_run') {
    return urnCloudRunSegment(attributes);
  }
  return null;
}

function urnLocationSegment(attributes: Record<string, unknown>): string {
  const zone = attributes['cloud.availability_zone'] as string | undefined;
  if (zone) {
    return `zones:${zone}`;
  }
  const region = attributes['cloud.region'] as string | undefined;
  if (region) {
    return `locations:${region}`;
  }
  return '';
}

async function getUrnEnrichedResource(
  resource: Resource,
  fallbackProjectId?: string,
): Promise<Resource> {
  const attributes = resource.attributes;
  if (attributes['gen_ai.main_agent.id']) {
    return emptyResource();
  }

  const workload = urnWorkloadSegment(attributes);
  if (!workload) {
    return emptyResource();
  }

  const projectId =
    (attributes['cloud.account.id'] as string | undefined) || fallbackProjectId;
  if (!projectId) {
    logger.warn('The project ID is unknown, so no agent URN is set.');
    return emptyResource();
  }

  const projectInfo = await fetchProject(projectId);
  if (!projectInfo.number) {
    logger.warn(
      `The number of project '${projectId}' is unknown, so no agent URN is set.`,
    );
    return emptyResource();
  }

  const location = urnLocationSegment(attributes);
  if (!location) {
    logger.warn(
      'Neither a zone nor a region could be detected, so no agent URN is set.',
    );
    return emptyResource();
  }

  const urn = [
    'urn:agent',
    `projects-${projectInfo.number}`,
    `projects:${projectInfo.number}`,
    location,
    workload,
  ].join(':');

  return resourceFromAttributes({'gen_ai.main_agent.id': urn});
}

/**
 * Builds the OTel resource describing a Google Cloud deployment.
 *
 * Applies layered precedence: common resource, Agent Runtime resource,
 * OTel environment detector, GCP detector, and Agent Registry URN enrichment.
 *
 * @param projectId Optional project ID. Falls back to GOOGLE_CLOUD_PROJECT or ADC.
 * @returns Detected Resource object.
 */
export async function getGcpResource(projectId?: string): Promise<Resource> {
  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    resolvedProjectId = await getGcpProjectId();
  }

  const instanceId = `${randomUUID().replace(/-/g, '')}-${process.pid}`;
  const commonAttributes: Record<string, string> = {
    'service.instance.id': instanceId,
  };
  if (resolvedProjectId) {
    commonAttributes['gcp.project_id'] = resolvedProjectId;
    commonAttributes['cloud.account.id'] = resolvedProjectId;
  } else {
    logger.warn(
      'No project could be determined, so telemetry will not name one. Set GOOGLE_CLOUD_PROJECT, or pass a project explicitly, if it should.',
    );
  }
  let resource = resourceFromAttributes(commonAttributes);

  const agentEngineId = process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID;
  if (agentEngineId) {
    const location =
      process.env.GOOGLE_CLOUD_AGENT_ENGINE_LOCATION ||
      process.env.GOOGLE_CLOUD_LOCATION ||
      '';
    if (!location) {
      logger.warn(
        'On Agent Runtime with no location set, so this deployment cannot be named. Set GOOGLE_CLOUD_AGENT_ENGINE_LOCATION or GOOGLE_CLOUD_LOCATION.',
      );
    }
    const aeAttributes: Record<string, string> = {
      'cloud.provider': 'gcp',
      'cloud.platform': 'gcp.agent_engine',
      'service.name': agentEngineId,
      'service.version':
        process.env.GOOGLE_CLOUD_AGENT_ENGINE_RUNTIME_REVISION_ID ?? '',
      'cloud.region': location,
    };
    if (resolvedProjectId && location) {
      aeAttributes['cloud.resource_id'] =
        `//aiplatform.googleapis.com/projects/${resolvedProjectId}/locations/${location}/reasoningEngines/${agentEngineId}`;
    }
    resource = resource.merge(
      defaultResource().merge(resourceFromAttributes(aeAttributes)),
    );
  }

  const otelDetected = detectResources({detectors: [envDetector]});
  resource = resource.merge(otelDetected);

  if (!agentEngineId) {
    try {
      const gcpDetected = detectResources({detectors: [gcpDetector]});
      if (gcpDetected.asyncAttributesPending) {
        await gcpDetected.waitForAsyncAttributes?.();
      }
      resource = resource.merge(gcpDetected);
    } catch (error: unknown) {
      logger.warn(
        'Could not detect GCP resource attributes. GCE, GKE or CloudRun related resource attributes may be missing.',
        {error},
      );
    }
  }

  const urnResource = await getUrnEnrichedResource(resource, resolvedProjectId);
  resource = resource.merge(urnResource);

  return resource;
}

/**
 * Returns OTel processors and readers configured for export to Google Cloud.
 *
 * Sends traces, metrics, and logs via OTLP over HTTP to telemetry.googleapis.com.
 *
 * @param config Configuration options for enabled signals and project.
 * @returns OTelHooks containing configured processors and readers.
 */
export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    enableLogging = false,
    auth: providedAuth,
  } = config;

  const auth =
    providedAuth ??
    new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
    });

  let projectId = config.projectId;
  if (!projectId) {
    projectId = await getGcpProjectId(auth);
  }

  if (process.env.GOOGLE_CLOUD_AGENT_ENGINE_ID && projectId) {
    const projectInfo = await fetchProject(projectId, auth);
    projectId = projectInfo.id || projectId;
  }

  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  const userAgentHeaders = getAgentEngineUserAgentHeader();

  const spanProcessors = enableTracing
    ? [
        new BatchSpanProcessor(
          new AuthenticatedTraceExporter(
            auth,
            getTelemetryEndpoint(
              DEFAULT_TELEMETRY_TRACES_ENDPOINT,
              DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
            ),
            userAgentHeaders,
          ),
        ),
      ]
    : [];

  const metricReaders = enableMetrics
    ? [
        new PeriodicExportingMetricReader({
          exporter: new AuthenticatedMetricExporter(
            auth,
            getTelemetryEndpoint(
              DEFAULT_TELEMETRY_METRICS_ENDPOINT,
              DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
            ),
            userAgentHeaders,
          ),
          exportIntervalMillis: 5000,
        }),
      ]
    : [];

  const logRecordProcessors = enableLogging
    ? [
        new GCPBatchLogRecordProcessor(
          new AuthenticatedLogExporter(
            auth,
            getTelemetryEndpoint(
              DEFAULT_TELEMETRY_LOGS_ENDPOINT,
              DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
            ),
            userAgentHeaders,
          ),
          projectId,
        ),
      ]
    : [];

  return {
    spanProcessors,
    metricReaders,
    logRecordProcessors,
  };
}
