/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exports OpenTelemetry log records to Cloud Logging through the OTLP endpoint
 * of `telemetry.googleapis.com`.
 */

import {OTLPLogExporter} from '@opentelemetry/exporter-logs-otlp-http';
import {resourceFromAttributes, type Resource} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import type {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';

import {readEnvVar, readNonEmptyEnvVar} from './env.js';

/** Plain OTLP/HTTP logs endpoint of `telemetry.googleapis.com`. */
export const DEFAULT_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.googleapis.com/v1/logs';

/** mTLS OTLP/HTTP logs endpoint of `telemetry.googleapis.com`. */
export const DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT =
  'https://telemetry.mtls.googleapis.com/v1/logs';

/**
 * OAuth scope the exporter authenticates with. A service-account key has no
 * default scope, so one has to be asked for explicitly.
 */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/** Environment variable that overrides the default Cloud Logging log name. */
const GCP_DEFAULT_LOG_NAME = 'GCP_DEFAULT_LOG_NAME';

/** Default log name off Agent Engine. */
const ADK_OTEL_LOG_NAME = 'adk-otel';

/**
 * Default log name on Agent Engine, which is where OTel logs went when they
 * were written to stdout there; kept for backward compatibility.
 */
const AGENT_ENGINE_LOG_NAME =
  'aiplatform.googleapis.com/reasoning_engine_stdout';

/** Log record and resource attribute keys Cloud Logging reads. */
enum GcpLogAttr {
  LOG_NAME = 'gcp.log_name',
  EVENT_NAME = 'event.name',
  RESOURCE_TYPE = 'gcp.resource_type',
  LOCATION = 'location',
  REASONING_ENGINE_ID = 'reasoning_engine_id',
  RESOURCE_CONTAINER = 'resource_container',
  SERVICE_VERSION = 'service.version',
}

/** Accepted values of `GOOGLE_API_USE_MTLS_ENDPOINT`. */
const MTLS_ENDPOINT_MODES = ['auto', 'always', 'never'] as const;
type MtlsEndpointMode = (typeof MTLS_ENDPOINT_MODES)[number];

/** Callback the SDK passes to {@link LogRecordExporter.export}. */
type ExportResultCallback = Parameters<LogRecordExporter['export']>[1];

function isMtlsEndpointMode(value: string): value is MtlsEndpointMode {
  return (MTLS_ENDPOINT_MODES as readonly string[]).includes(value);
}

/**
 * Returns whether a client certificate should be used, from
 * `GOOGLE_API_USE_CLIENT_CERTIFICATE`. A value other than `true` or `false`
 * warns and counts as `false`.
 */
function useClientCertificate(): boolean {
  const value = (
    readEnvVar('GOOGLE_API_USE_CLIENT_CERTIFICATE') ?? 'false'
  ).toLowerCase();
  if (value !== 'true' && value !== 'false') {
    logger.warn(
      'Environment variable `GOOGLE_API_USE_CLIENT_CERTIFICATE` must be either `true` or `false`',
    );
  }
  return value === 'true';
}

/**
 * Returns the `GOOGLE_API_USE_MTLS_ENDPOINT` mode. An unrecognized value warns
 * and falls back to `auto`.
 */
function mtlsEndpointMode(): MtlsEndpointMode {
  const value = (
    readEnvVar('GOOGLE_API_USE_MTLS_ENDPOINT') ?? 'auto'
  ).toLowerCase();
  if (isMtlsEndpointMode(value)) {
    return value;
  }
  logger.warn(
    `Environment variable \`GOOGLE_API_USE_MTLS_ENDPOINT\` must be one of ${MTLS_ENDPOINT_MODES.join(', ')}. Defaulting to auto.`,
  );
  return 'auto';
}

/** Parameters for {@link selectTelemetryEndpoint}. */
export interface SelectTelemetryEndpointParams {
  /** The endpoint to use without mTLS. */
  defaultEndpoint: string;
  /** The endpoint to use with mTLS. */
  mtlsEndpoint: string;
  /** Whether a default client certificate source is available. */
  hasClientCertSource?: boolean;
}

/**
 * Picks the plain or the mTLS telemetry endpoint.
 *
 * With `GOOGLE_API_USE_CLIENT_CERTIFICATE` off the plain endpoint is used.
 * Otherwise `GOOGLE_API_USE_MTLS_ENDPOINT=always` selects the mTLS endpoint,
 * `never` the plain one, and `auto` the mTLS one only when a client
 * certificate source is available.
 */
export function selectTelemetryEndpoint({
  defaultEndpoint,
  mtlsEndpoint,
  hasClientCertSource = false,
}: SelectTelemetryEndpointParams): string {
  if (!useClientCertificate()) {
    return defaultEndpoint;
  }
  const mode = mtlsEndpointMode();
  if (mode === 'always' || (mode === 'auto' && hasClientCertSource)) {
    return mtlsEndpoint;
  }
  return defaultEndpoint;
}

/**
 * Returns the resource Cloud Logging needs on Agent Engine, or an empty one
 * elsewhere.
 *
 * It goes on log records only: `gcp.resource_type` also steers metric
 * ingestion, so putting it on the resource that traces and metrics share
 * would move Agent Engine metrics off their monitored resource.
 */
function agentEngineLogResource(projectId: string): Resource {
  const agentEngineId = readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID');
  if (!agentEngineId) {
    return resourceFromAttributes({});
  }
  const location =
    readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_LOCATION') ??
    readNonEmptyEnvVar('GOOGLE_CLOUD_LOCATION') ??
    '';
  return resourceFromAttributes({
    // Cloud Logging otherwise detects the resource as `generic_task`.
    [GcpLogAttr.RESOURCE_TYPE]: 'aiplatform.googleapis.com/ReasoningEngine',
    [GcpLogAttr.LOCATION]: location,
    [GcpLogAttr.REASONING_ENGINE_ID]: agentEngineId,
    // Without `projects/`, telemetry.googleapis.com returns a 4xx.
    [GcpLogAttr.RESOURCE_CONTAINER]: `projects/${projectId}`,
  });
}

/** Parameters for {@link GcpLogRecordExporter}. */
export interface GcpLogRecordExporterParams {
  /** The exporter that sends the rewritten records. */
  exporter: LogRecordExporter;
  /** The project the records are reported to. */
  projectId: string;
}

/**
 * Wraps a log exporter and rewrites each record for Cloud Logging, on a copy.
 *
 * The SDK hands the same record to every processor, so the record itself is
 * never changed. The rewrites run at export time, after the batch processor
 * has waited for asynchronous resource attributes to settle.
 */
export class GcpLogRecordExporter implements LogRecordExporter {
  private readonly exporter: LogRecordExporter;
  private readonly logResource: Resource;
  private readonly defaultLogName: string;
  /**
   * The merged resource per input resource. The OTLP serializer groups
   * records by resource identity, so each input has to map to one object.
   */
  private readonly mergedResources = new WeakMap<Resource, Resource>();

  constructor({exporter, projectId}: GcpLogRecordExporterParams) {
    this.exporter = exporter;
    this.logResource = agentEngineLogResource(projectId);
    this.defaultLogName =
      readNonEmptyEnvVar(GCP_DEFAULT_LOG_NAME) ??
      (readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID')
        ? AGENT_ENGINE_LOG_NAME
        : ADK_OTEL_LOG_NAME);
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: ExportResultCallback,
  ): void {
    const onAgentEngine =
      readNonEmptyEnvVar('GOOGLE_CLOUD_AGENT_ENGINE_ID') !== undefined;
    this.exporter.export(
      logs.map((record) => this.rewrite(record, onAgentEngine)),
      resultCallback,
    );
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush?.();
  }

  private rewrite(
    record: ReadableLogRecord,
    onAgentEngine: boolean,
  ): ReadableLogRecord {
    const attributes = {...record.attributes};
    if (record.eventName && !Object.hasOwn(attributes, GcpLogAttr.EVENT_NAME)) {
      attributes[GcpLogAttr.EVENT_NAME] = record.eventName;
    }
    if (!Object.hasOwn(attributes, GcpLogAttr.LOG_NAME)) {
      attributes[GcpLogAttr.LOG_NAME] = this.defaultLogName;
    }
    const resource = this.mergeResource(record.resource);
    // Resource attributes are dropped once ingested as a monitored resource,
    // so the version has to travel as a label to stay queryable.
    const serviceVersion = resource.attributes[GcpLogAttr.SERVICE_VERSION];
    if (
      serviceVersion &&
      !Object.hasOwn(attributes, GcpLogAttr.SERVICE_VERSION)
    ) {
      attributes[GcpLogAttr.SERVICE_VERSION] = serviceVersion;
    }
    return {
      hrTime: record.hrTime,
      hrTimeObserved: record.hrTimeObserved,
      spanContext: record.spanContext,
      severityText: record.severityText,
      severityNumber: record.severityNumber,
      body: record.body,
      // Cloud Logging derives the log name from the event name in preference
      // to `gcp.log_name`. On Agent Engine that would scatter records over one
      // log per event type, so the name travels only as `event.name` there.
      // Elsewhere the event-named log is the established one and stays.
      eventName: onAgentEngine ? undefined : record.eventName,
      resource,
      instrumentationScope: record.instrumentationScope,
      attributes,
      droppedAttributesCount: record.droppedAttributesCount,
    };
  }

  private mergeResource(resource: Resource): Resource {
    let merged = this.mergedResources.get(resource);
    if (!merged) {
      merged = resource.merge(this.logResource);
      this.mergedResources.set(resource, merged);
    }
    return merged;
  }
}

/** Parameters for {@link createGcpLogRecordProcessor}. */
export interface CreateGcpLogRecordProcessorParams {
  /** The project the records are reported to. */
  projectId: string;
  /** Credentials, asked for fresh request headers on every export. */
  auth: Pick<GoogleAuth, 'getRequestHeaders'>;
  /** Overrides the endpoint that {@link selectTelemetryEndpoint} picks. */
  endpoint?: string;
  /** Overrides the OTLP exporter the Cloud Logging rewrites feed. */
  exporter?: LogRecordExporter;
}

/**
 * Returns a headers factory for one processor. Never throws, because the OTLP
 * exporter requires a headers factory that does not, and warns at most once
 * when fetching credentials fails.
 */
function createAuthorizationHeadersFactory(
  auth: Pick<GoogleAuth, 'getRequestHeaders'>,
): () => Promise<Record<string, string>> {
  let warned = false;
  return async () => {
    try {
      const headers: Record<string, string> = {};
      (await auth.getRequestHeaders()).forEach((value, name) => {
        headers[name] = value;
      });
      return headers;
    } catch {
      if (!warned) {
        warned = true;
        // The error text can carry credential details, so it is not logged.
        logger.warn(
          'Failed to get Google Cloud credentials for Cloud Logging export.',
        );
      }
      return {};
    }
  };
}

/**
 * Builds the batching log processor that exports to Cloud Logging over
 * OTLP/HTTP, authenticating each request with `auth`.
 */
export function createGcpLogRecordProcessor({
  projectId,
  auth,
  endpoint,
  exporter,
}: CreateGcpLogRecordProcessorParams): LogRecordProcessor {
  const otlpExporter =
    exporter ??
    new OTLPLogExporter({
      url:
        endpoint ??
        selectTelemetryEndpoint({
          defaultEndpoint: DEFAULT_TELEMETRY_LOGS_ENDPOINT,
          mtlsEndpoint: DEFAULT_MTLS_TELEMETRY_LOGS_ENDPOINT,
        }),
      headers: createAuthorizationHeadersFactory(auth),
    });
  return new BatchLogRecordProcessor({
    exporter: new GcpLogRecordExporter({exporter: otlpExporter, projectId}),
  });
}
