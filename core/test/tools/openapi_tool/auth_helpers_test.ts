/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  applyCredential,
  createApiKeyScheme,
  createBearerScheme,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';

describe('auth_helpers', () => {
  describe('applyCredential', () => {
    it('should return original url if no credential provided', () => {
      const url = 'https://example.com';
      const headers = {};
      const result = applyCredential(url, headers, undefined);
      expect(result).toBe(url);
      expect(headers).toEqual({});
    });

    it('should apply API key in header', () => {
      const url = 'https://example.com';
      const headers: Record<string, string> = {};
      const credential = {api_key: 'my-key'};
      const authScheme = {in: 'header', name: 'X-API-Key'};

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe(url);
      expect(headers['X-API-Key']).toBe('my-key');
    });

    it('should apply API key in query', () => {
      const url = 'https://example.com';
      const headers: Record<string, string> = {};
      const credential = {api_key: 'my-key'};
      const authScheme = {in: 'query', name: 'key'};

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe('https://example.com?key=my-key');
      expect(headers).toEqual({});
    });

    it('should apply API key in query with existing params', () => {
      const url = 'https://example.com?existing=param';
      const headers: Record<string, string> = {};
      const credential = {api_key: 'my-key'};
      const authScheme = {in: 'query', name: 'key'};

      const result = applyCredential(url, headers, credential, authScheme);

      expect(result).toBe('https://example.com?existing=param&key=my-key');
    });

    it('should apply bearer token', () => {
      const url = 'https://example.com';
      const headers: Record<string, string> = {};
      const credential = {
        http: {
          credentials: {
            token: 'my-token',
          },
        },
      };

      const result = applyCredential(url, headers, credential);

      expect(result).toBe(url);
      expect(headers['Authorization']).toBe('Bearer my-token');
    });
  });

  describe('helpers', () => {
    it('should create API key scheme', () => {
      const scheme = createApiKeyScheme('X-API-Key', 'header');
      expect(scheme).toEqual({
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      });
    });

    it('should create bearer scheme', () => {
      const scheme = createBearerScheme();
      expect(scheme).toEqual({
        type: 'http',
        scheme: 'bearer',
      });
    });
  });
});
