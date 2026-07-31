/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';
import {getBooleanEnvVar, randomUUID} from '../../src/utils/env_aware_utils.js';

describe('env_aware_utils', () => {
  describe('getBooleanEnvVar', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return true for "true" (case-insensitive)', () => {
      process.env = {...originalEnv, 'TEST_VAR': 'true'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);

      process.env = {...originalEnv, 'TEST_VAR': 'TRUE'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);

      process.env = {...originalEnv, 'TEST_VAR': 'True'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);
    });

    it('should return true for "1"', () => {
      process.env = {...originalEnv, 'TEST_VAR': '1'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);
    });

    it('should return false for "false"', () => {
      process.env = {...originalEnv, 'TEST_VAR': 'false'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for "0"', () => {
      process.env = {...originalEnv, 'TEST_VAR': '0'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for empty string', () => {
      process.env = {...originalEnv, 'TEST_VAR': ''};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(getBooleanEnvVar('NON_EXISTENT_VAR')).toBe(false);
    });
  });

  describe('randomUUID', () => {
    const originalCrypto = globalThis.crypto;

    afterEach(() => {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    });

    const setCrypto = (value: unknown) => {
      Object.defineProperty(globalThis, 'crypto', {
        value,
        configurable: true,
        writable: true,
      });
    };

    const UUID_V4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('uses crypto.randomUUID when it is available', () => {
      setCrypto({
        randomUUID: () => '00000000-0000-4000-8000-000000000000',
        getRandomValues: () => {
          throw new Error('getRandomValues must not be called');
        },
      });

      expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000');
    });

    it('returns a valid v4 UUID on this runtime', () => {
      expect(randomUUID()).toMatch(UUID_V4);
    });

    // crypto.randomUUID is a secure-context-only API, so it is absent on
    // plain-HTTP origins while crypto.getRandomValues remains available.
    it('falls back to crypto.getRandomValues when randomUUID is absent', () => {
      const getRandomValues =
        originalCrypto.getRandomValues.bind(originalCrypto);
      setCrypto({getRandomValues});

      expect(randomUUID()).toMatch(UUID_V4);
    });

    it('draws every byte from getRandomValues, not Math.random', () => {
      const getRandomValues = (array: Uint8Array) => {
        array.fill(0xab);
        return array;
      };
      setCrypto({getRandomValues});

      // 0xab in every byte, with the RFC 4122 version and variant bits applied.
      expect(randomUUID()).toBe('abababab-abab-4bab-abab-abababababab');
    });

    it('throws instead of degrading when no secure source exists', () => {
      setCrypto(undefined);

      expect(() => randomUUID()).toThrow(
        /no cryptographically secure source of randomness/,
      );
    });
  });
});
