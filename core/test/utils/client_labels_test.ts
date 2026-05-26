/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getClientLabels} from '../../src/utils/client_labels.js';

describe('client_labels', () => {
  describe('getClientLabels', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {...originalEnv};
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should return an array of label strings', () => {
      const labels = getClientLabels();
      expect(Array.isArray(labels)).toBe(true);
      expect(labels.length).toBeGreaterThan(0);
    });

    it('should include google-adk label with version', () => {
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).toBeDefined();
    });

    it('should include gl-typescript language label', () => {
      const labels = getClientLabels();
      const langLabel = labels.find((l) => l.startsWith('gl-typescript/'));
      expect(langLabel).toBeDefined();
    });

    it('should include agent engine telemetry tag when env variable is set', () => {
      process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'my-engine-id';
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).toContain('remote_reasoning_engine');
    });

    it('should not include agent engine telemetry tag when env variable is not set', () => {
      delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).not.toContain('remote_reasoning_engine');
    });

    it('should return exactly two labels in Node.js environment', () => {
      const labels = getClientLabels();
      expect(labels).toHaveLength(2);
    });
  });
});
