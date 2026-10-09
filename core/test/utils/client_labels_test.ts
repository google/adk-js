/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels, runWithClientLabel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getTrackingHeaders,
  mergeTrackingHeaders,
  parseUserAgent,
} from '../../src/utils/client_labels.js';
import {logger} from '../../src/utils/logger.js';

describe('client_labels', () => {
  describe('parseUserAgent', () => {
    it('should parse Chrome UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
      expect(parseUserAgent(ua)).toBe('Chrome/123.0.0.0');
    });

    it('should parse Chrome iOS UA', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1';
      expect(parseUserAgent(ua)).toBe('Chrome/123.0.6312.52');
    });

    it('should parse Firefox UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0';
      expect(parseUserAgent(ua)).toBe('Firefox/123.0');
    });

    it('should parse Firefox iOS UA', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/123.0 Mobile/15E148 Safari/605.1.15';
      expect(parseUserAgent(ua)).toBe('Firefox/123.0');
    });

    it('should parse Edge UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0';
      expect(parseUserAgent(ua)).toBe('Edge/123.0.0.0');
    });

    it('should parse Safari UA', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15';
      expect(parseUserAgent(ua)).toBe('Safari/17.3');
    });

    it('should fallback to Browser for unknown UA', () => {
      expect(parseUserAgent('Unknown UA')).toBe('Browser');
      expect(parseUserAgent('')).toBe('Browser');
    });
  });

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

    it('should return exactly two labels in Node.js environment by default', () => {
      const labels = getClientLabels();
      expect(labels).toHaveLength(2);
    });
  });

  describe('runWithClientLabel', () => {
    it('should append custom label in context', () => {
      const customLabel = 'my-custom-label';
      runWithClientLabel(customLabel, () => {
        const labels = getClientLabels();
        expect(labels).toContain(customLabel);
        expect(labels).toHaveLength(3);
      });
    });

    it('should clean up custom label after callback', () => {
      const customLabel = 'my-custom-label';
      runWithClientLabel(customLabel, () => {
        // inside
      });
      const labels = getClientLabels();
      expect(labels).not.toContain(customLabel);
      expect(labels).toHaveLength(2);
    });

    it('should propagate label across async hops', async () => {
      const customLabel = 'async-label';
      await runWithClientLabel(customLabel, async () => {
        expect(getClientLabels()).toContain(customLabel);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getClientLabels()).toContain(customLabel);

        await Promise.resolve();
        expect(getClientLabels()).toContain(customLabel);
      });
    });

    it('should throw error for empty label', () => {
      expect(() => {
        runWithClientLabel('', () => {});
      }).toThrow('Client label must be a non-empty string.');

      expect(() => {
        runWithClientLabel('   ', () => {});
      }).toThrow('Client label must be a non-empty string.');
    });
  });

  describe('tracking headers', () => {
    const adkValue = () => getClientLabels().join(' ');

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('getTrackingHeaders returns both headers with the client labels', () => {
      const headers = getTrackingHeaders();
      expect(headers).toEqual({
        'x-goog-api-client': adkValue(),
        'user-agent': adkValue(),
      });
      expect(Object.keys(headers)).toEqual(['x-goog-api-client', 'user-agent']);
      expect(headers['user-agent']).toMatch(/^google-adk\//);
    });

    it('adds the tracking headers when there are no caller headers', () => {
      const expected = {
        'x-goog-api-client': adkValue(),
        'user-agent': adkValue(),
      };
      expect(mergeTrackingHeaders()).toEqual(expected);
      expect(mergeTrackingHeaders({})).toEqual(expected);
    });

    it.each(['user-agent', 'User-Agent', 'USER-AGENT'])(
      'folds a caller %s onto the lower-case key after the ADK tokens',
      (name) => {
        const merged = mergeTrackingHeaders({[name]: 'my-app/1.0'});

        expect(Object.keys(merged).sort()).toEqual([
          'user-agent',
          'x-goog-api-client',
        ]);
        expect(merged['user-agent']).toMatch(/^google-adk\//);
        expect(merged['user-agent'].endsWith(' my-app/1.0')).toBe(true);
        expect(merged['user-agent']).toBe(`${adkValue()} my-app/1.0`);
        expect(merged['x-goog-api-client']).toBe(adkValue());
      },
    );

    it('folds a caller X-Goog-Api-Client onto the lower-case key', () => {
      const merged = mergeTrackingHeaders({'X-Goog-Api-Client': 'gl-other/2'});

      expect(merged).not.toHaveProperty('X-Goog-Api-Client');
      expect(merged['x-goog-api-client']).toBe(`${adkValue()} gl-other/2`);
      expect(merged['user-agent']).toBe(adkValue());
    });

    it('collects every casing of a tracking header in encounter order', () => {
      const merged = mergeTrackingHeaders({
        'User-Agent': 'first/1',
        'user-agent': 'second/2',
      });

      expect(merged).toEqual({
        'x-goog-api-client': adkValue(),
        'user-agent': `${adkValue()} first/1 second/2`,
      });
    });

    it('drops duplicate tokens', () => {
      const [adkToken] = getClientLabels();
      const merged = mergeTrackingHeaders({
        'User-Agent': `${adkToken} my-app/1.0   my-app/1.0`,
      });

      expect(merged['user-agent']).toBe(`${adkValue()} my-app/1.0`);
    });

    it('uses the ADK value when the caller value is empty', () => {
      expect(mergeTrackingHeaders({'user-agent': ''})['user-agent']).toBe(
        adkValue(),
      );
    });

    it('passes other headers through with their original spelling', () => {
      const merged = mergeTrackingHeaders({
        'Authorization': 'Bearer token',
        'X-Custom': 'value',
      });

      expect(merged).toEqual({
        'Authorization': 'Bearer token',
        'X-Custom': 'value',
        'x-goog-api-client': adkValue(),
        'user-agent': adkValue(),
      });
    });

    it('accepts a Headers object', () => {
      const merged = mergeTrackingHeaders(
        new Headers({'User-Agent': 'my-app/1.0', 'X-Custom': 'value'}),
      );

      expect(merged).toEqual({
        'x-custom': 'value',
        'x-goog-api-client': adkValue(),
        'user-agent': `${adkValue()} my-app/1.0`,
      });
    });

    it('keeps the comma that Headers puts between repeated values', () => {
      const headers = new Headers();
      headers.append('User-Agent', 'first/1');
      headers.append('User-Agent', 'second/2');

      expect(mergeTrackingHeaders(headers)['user-agent']).toBe(
        `${adkValue()} first/1, second/2`,
      );
    });

    it('accepts an array of header pairs', () => {
      const merged = mergeTrackingHeaders([
        ['User-Agent', 'my-app/1.0'],
        ['X-Custom', 'value'],
      ]);

      expect(merged).toEqual({
        'X-Custom': 'value',
        'x-goog-api-client': adkValue(),
        'user-agent': `${adkValue()} my-app/1.0`,
      });
    });

    it('preserves repeated non-tracking headers from header pairs', () => {
      const callerHeaders: Array<[string, string]> = [
        ['X-Custom', 'first'],
        ['X-Custom', 'second'],
      ];

      const merged = mergeTrackingHeaders(callerHeaders);

      expect(merged['X-Custom']).toBe(
        new Headers(callerHeaders).get('X-Custom'),
      );
    });

    it('matches repeated non-tracking header names case-insensitively', () => {
      const callerHeaders: Array<[string, string]> = [
        ['X-Custom', 'first'],
        ['x-custom', 'second'],
      ];

      const merged = mergeTrackingHeaders(callerHeaders);

      expect(merged['X-Custom']).toBe(
        new Headers(callerHeaders).get('X-Custom'),
      );
      expect(
        Object.keys(merged).filter((name) => name.toLowerCase() === 'x-custom'),
      ).toHaveLength(1);
    });

    it('does not mutate the input', () => {
      const input = {'User-Agent': 'my-app/1.0', 'X-Custom': 'value'};
      const pairs: Array<[string, string]> = [['User-Agent', 'my-app/1.0']];
      const headers = new Headers({'User-Agent': 'my-app/1.0'});

      const merged = mergeTrackingHeaders(input);
      mergeTrackingHeaders(pairs);
      mergeTrackingHeaders(headers);

      expect(merged).not.toBe(input);
      expect(input).toEqual({'User-Agent': 'my-app/1.0', 'X-Custom': 'value'});
      expect(pairs).toEqual([['User-Agent', 'my-app/1.0']]);
      expect(headers.get('user-agent')).toBe('my-app/1.0');
      expect(headers.has('x-goog-api-client')).toBe(false);
    });

    it('includes a runWithClientLabel label', () => {
      runWithClientLabel('my-label', () => {
        const merged = mergeTrackingHeaders({'User-Agent': 'my-app/1.0'});

        expect(merged['x-goog-api-client']).toContain('my-label');
        expect(merged['user-agent']).toContain('my-label');
        expect(merged['user-agent'].endsWith(' my-label my-app/1.0')).toBe(
          true,
        );
        expect(getTrackingHeaders()['user-agent']).toContain('my-label');
      });
    });

    it('builds the headers in a browser without throwing or warning', () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      vi.stubGlobal('window', {
        navigator: {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        },
      });

      const merged = mergeTrackingHeaders({'User-Agent': 'my-app/1.0'});

      expect(merged['x-goog-api-client']).toContain(
        'gl-typescript/Chrome/123.0.0.0',
      );
      expect(merged['user-agent']).toBe(
        `${merged['x-goog-api-client']} my-app/1.0`,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
