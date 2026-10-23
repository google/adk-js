/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {Resource} from '@opentelemetry/resources';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';

import {
  CLOUD_PLATFORM_SCOPE,
  createAuthorizationHeadersFactory,
  createGcpLogRecordProcessor,
  DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
  DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
  DEFAULT_TELEMETRY_METRICS_ENDPOINT,
  DEFAULT_TELEMETRY_TRACES_ENDPOINT,
  selectTelemetryEndpoint,
} from './gcp_logging.js';
import {buildGcpResource, fetchProject} from './gcp_resource.js';
import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

async function resolveProjectId(
  auth: GoogleAuth,
  givenProjectId?: string,
): Promise<string | undefined> {
  let projectId = givenProjectId || undefined;
  if (!projectId) {
    try {
      projectId = (await auth.getProjectId()) || undefined;
    } catch (_e: unknown) {
      return undefined;
    }
  }
  if (projectId && process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID']) {
    // Associating logs with traces needs the project ID; keep what we have if
    // the lookup could not produce one.
    const {id} = await fetchProject(projectId, auth);
    projectId = id ? id : projectId;
  }
  return projectId;
}

/**
 * Returns the project ID of the Application Default Credentials, converting a
 * project number through Cloud Resource Manager on Agent Engine, or undefined
 * when none can be determined.
 */
export async function getGcpProjectId(): Promise<string | undefined> {
  return resolveProjectId(new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]}));
}

/** How often the metric reader exports, in milliseconds. */
const METRIC_EXPORT_INTERVAL_MS = 5000;

/**
 * Builds the span processor that exports traces to Cloud Trace over OTLP/HTTP
 * at `telemetry.googleapis.com`, authenticating each request with `auth`.
 */
function createCloudTraceProcessor(
  auth: Pick<GoogleAuth, 'getRequestHeaders'>,
): BatchSpanProcessor {
  return new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: selectTelemetryEndpoint({
        defaultEndpoint: DEFAULT_TELEMETRY_TRACES_ENDPOINT,
        mtlsEndpoint: DEFAULT_MTLS_TELEMETRY_TRACES_ENDPOINT,
      }),
      headers: createAuthorizationHeadersFactory(auth),
    }),
  );
}

/**
 * Builds the metric reader that exports metrics to Cloud Monitoring over
 * OTLP/HTTP at `telemetry.googleapis.com`, authenticating each request with
 * `auth`.
 */
function createCloudMetricReader(
  auth: Pick<GoogleAuth, 'getRequestHeaders'>,
): PeriodicExportingMetricReader {
  return new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: selectTelemetryEndpoint({
        defaultEndpoint: DEFAULT_TELEMETRY_METRICS_ENDPOINT,
        mtlsEndpoint: DEFAULT_MTLS_TELEMETRY_METRICS_ENDPOINT,
      }),
      headers: createAuthorizationHeadersFactory(auth),
    }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  });
}

/**
 * Returns the OTel hooks that export to Google Cloud: Cloud Trace for spans,
 * Cloud Monitoring for metrics and Cloud Logging for log records.
 *
 * All three export over OTLP/HTTP to `telemetry.googleapis.com` (or its mTLS
 * endpoint, as `GOOGLE_API_USE_MTLS_ENDPOINT` selects), with Application
 * Default Credentials on each request. Metrics are exported every 5 seconds.
 *
 * Returns no hooks when no project can be determined.
 */
export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    enableLogging = false,
    projectId: givenProjectId,
  } = config;

  const auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
  const projectId = await resolveProjectId(auth, givenProjectId);
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  return {
    spanProcessors: enableTracing ? [createCloudTraceProcessor(auth)] : [],
    metricReaders: enableMetrics ? [createCloudMetricReader(auth)] : [],
    logRecordProcessors: enableLogging
      ? [createGcpLogRecordProcessor({projectId, auth})]
      : [],
  };
}

/**
 * Returns the OTel resource describing this deployment on Google Cloud.
 *
 * It layers, with later sources winning: a per-process service instance and
 * the project; the Agent Engine deployment when `GOOGLE_CLOUD_AGENT_ENGINE_ID`
 * is set; `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`; the GCP resource
 * detector (skipped on Agent Engine); and the Agent Registry URN as
 * `gen_ai.main_agent.id` on Agent Engine, GKE and Cloud Run.
 *
 * @param projectId The project telemetry is reported to, used for
 *     `gcp.project_id` and `cloud.account.id`. Falls back to
 *     `GOOGLE_CLOUD_PROJECT` when omitted.
 */
export function getGcpResource(projectId?: string): Resource {
  return buildGcpResource(projectId);
}
