/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getGcpExporters, getGcpResource} from '../../src/telemetry/google_cloud.js';
import type { OtelExportersConfig} from '../../src/telemetry/setup.js';
import {GoogleAuth} from 'google-auth-library';
import {detectResources} from '@opentelemetry/resources';

// Mock Google Cloud modules
vi.mock('google-auth-library');
vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter');
vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter');
vi.mock('@opentelemetry/sdk-trace-base');
vi.mock('@opentelemetry/sdk-metrics');
vi.mock('@opentelemetry/sdk-logs');
vi.mock('@opentelemetry/resources');
vi.mock('@opentelemetry/resource-detector-gcp');
vi.mock('../../src/utils/logger.js');

describe('getGcpExporters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Test initializing correct providers in getGcpExporters
   * when enabling telemetry via Google Cloud.
   * 
   * This test is parameterized to test different combinations of GCP service options.
   */
  const testCases: Array<{
    config: OtelExportersConfig;
    expectedSpanProcessors: number;
    expectedMetricReaders: number;
    expectedLogRecordProcessors: number;
    description: string;
  }> = [
    {
      config: { enableTracing: true, enableMetrics: false, enableLogging: false },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Trace when enableTracing is true',
    },
    {
      config: { enableTracing: false, enableMetrics: true, enableLogging: false },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 0,
      description: 'should set up Cloud Monitoring when enableMetrics is true',
    },
    {
      config: { enableTracing: false, enableMetrics: false, enableLogging: true },
      expectedSpanProcessors: 0,
      expectedMetricReaders: 0,
      expectedLogRecordProcessors: 0, // Cloud Logging is not supported in Node.js
      description: 'should not set up Cloud Logging (unsupported in Node.js)',
    },
    {
      config: { enableTracing: true, enableMetrics: true, enableLogging: false },
      expectedSpanProcessors: 1,
      expectedMetricReaders: 1,
      expectedLogRecordProcessors: 0,
      description: 'should set up multiple exporters when multiple options are enabled',
    },
  ];

  testCases.forEach(({ config, expectedSpanProcessors, expectedMetricReaders, expectedLogRecordProcessors, description }) => {
    it(description, async () => {
      const mockAuth = {
        getProjectId: vi.fn().mockResolvedValue('test-project'),
      };
      vi.mocked(GoogleAuth).mockImplementation(() => mockAuth as any);

      const result = await getGcpExporters(config);

      expect(result.spanProcessors?.length).toBe(expectedSpanProcessors);
      expect(result.metricReaders?.length).toBe(expectedMetricReaders);
      expect(result.logRecordProcessors?.length).toBe(expectedLogRecordProcessors);
    });
  });

  it('should return empty hooks when GoogleAuth fails to get project ID', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockRejectedValue(new Error('Auth error')),
    };
    vi.mocked(GoogleAuth).mockImplementation(() => mockAuth as any);

    const result = await getGcpExporters({ enableTracing: true });

    expect(result).toEqual({});
  });

  it('should return empty hooks when project ID is null', async () => {
    const mockAuth = {
      getProjectId: vi.fn().mockResolvedValue(null),
    };
    vi.mocked(GoogleAuth).mockImplementation(() => mockAuth as any);

    const result = await getGcpExporters({ enableTracing: true });

    expect(result).toEqual({});
  });
});

describe('getGcpResource', () => {
  it('should detect GCP resources using gcpDetector', async () => {
    const mockDetectedResource = { attributes: { 'cloud.provider': 'gcp' } };
    vi.mocked(detectResources).mockResolvedValue(mockDetectedResource as any);

    const result = await getGcpResource();

    expect(detectResources).toHaveBeenCalledWith({
      detectors: [expect.any(Object)],
    });
    expect(result).toEqual(mockDetectedResource);
  });
});