/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {detectResources, Resource} from '@opentelemetry/resources';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

async function getGcpProjectId(): Promise<string | undefined> {
  try {
    const auth = new GoogleAuth();
    const projectId = await auth.getProjectId();
    return projectId || undefined;
  } catch (_e: unknown) {
    return undefined;
  }
}

/** Builds the Cloud Trace span processor, loading its exporter on demand. */
async function createCloudTraceProcessor(
  projectId: string,
): Promise<BatchSpanProcessor> {
  const {TraceExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-trace-exporter',
      feature: 'getGcpExporters({enableTracing: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-trace-exporter'),
  );
  return new BatchSpanProcessor(new TraceExporter({projectId}));
}

/** Builds the Cloud Monitoring metric reader, loading its exporter on demand. */
async function createCloudMetricReader(
  projectId: string,
): Promise<PeriodicExportingMetricReader> {
  const {MetricExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
      feature: 'getGcpExporters({enableMetrics: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-monitoring-exporter'),
  );
  return new PeriodicExportingMetricReader({
    exporter: new MetricExporter({projectId}),
    exportIntervalMillis: 5000,
  });
}

export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    // enableCloudLogging = false,
  } = config;

  const projectId = await getGcpProjectId();
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  return {
    spanProcessors: enableTracing
      ? [await createCloudTraceProcessor(projectId)]
      : [],
    metricReaders: enableMetrics
      ? [await createCloudMetricReader(projectId)]
      : [],
    logRecordProcessors: [],
  };
}

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
