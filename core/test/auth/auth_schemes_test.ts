/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuthGrantType} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {getOAuthGrantTypeFromFlow} from '../../src/auth/auth_schemes.js';

describe('auth_schemes', () => {
  describe('getOAuthGrantTypeFromFlow', () => {
    it('returns CLIENT_CREDENTIALS when clientCredentials is present', () => {
      const flow = {
        clientCredentials: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(
        OAuthGrantType.CLIENT_CREDENTIALS,
      );
    });

    it('returns AUTHORIZATION_CODE when authorizationCode is present', () => {
      const flow = {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(
        OAuthGrantType.AUTHORIZATION_CODE,
      );
    });

    it('returns IMPLICIT when implicit is present', () => {
      const flow = {
        implicit: {
          authorizationUrl: 'https://example.com/auth',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(OAuthGrantType.IMPLICIT);
    });

    it('returns PASSWORD when password is present', () => {
      const flow = {
        password: {
          tokenUrl: 'https://example.com/token',
          scopes: {},
        },
      };
      expect(getOAuthGrantTypeFromFlow(flow)).toBe(OAuthGrantType.PASSWORD);
    });

    it('returns undefined when no flow matches', () => {
      const flow = {};
      expect(getOAuthGrantTypeFromFlow(flow)).toBeUndefined();
    });
  });
});
