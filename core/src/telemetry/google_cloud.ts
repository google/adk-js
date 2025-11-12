/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {detectResources, Resource} from '@opentelemetry/resources';
import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {TraceExporter} from '@google-cloud/opentelemetry-cloud-trace-exporter';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {MetricExporter} from '@google-cloud/opentelemetry-cloud-monitoring-exporter';

import {logger} from '../utils/logger.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE = 
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

async function getGcpProjectId(): Promise<string | undefined> {
  try {
    const auth = new GoogleAuth();
    const projectId = await auth.getProjectId();
    return projectId || undefined;
  } catch (error) {
    return undefined;
  }
}

export async function getGcpExporters(config: OtelExportersConfig = {}): Promise<OTelHooks> {
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
    spanProcessors: enableTracing ? [
      new BatchSpanProcessor(new TraceExporter({ projectId })),
    ] : [],
    metricReaders: enableMetrics ? [
      new PeriodicExportingMetricReader({
        exporter: new MetricExporter({ projectId }),
        exportIntervalMillis: 5000,
      }),
    ] : [],
    logRecordProcessors: [],
  };
}

export function getGcpResource(): Resource {
  return detectResources({ detectors: [gcpDetector] });
}