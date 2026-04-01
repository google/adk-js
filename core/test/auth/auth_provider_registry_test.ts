/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthProviderRegistry, AuthScheme, BaseAuthProvider} from '@google/adk';
import {describe, expect, it} from 'vitest';

// Mock auth provider for testing
class MockAuthProvider implements BaseAuthProvider {
  async getAuthCredential() {
    return undefined;
  }
}

describe('AuthProviderRegistry', () => {
  it('should initialize with an empty registry', () => {
    const registry = new AuthProviderRegistry();

    const authScheme: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    expect(registry.getProvider(authScheme)).toBeUndefined();
  });

  it('should register a single provider', () => {
    const registry = new AuthProviderRegistry();
    const mockProvider = new MockAuthProvider();

    registry.register('apiKey', mockProvider);

    const authScheme: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    const retrievedProvider = registry.getProvider(authScheme);
    expect(retrievedProvider).toBe(mockProvider);
  });

  it('should return undefined for a not registered provider type', () => {
    const registry = new AuthProviderRegistry();
    const mockProvider = new MockAuthProvider();

    registry.register('apiKey', mockProvider);

    const authSchemeOauth2: AuthScheme = {
      type: 'oauth2',
      flows: {
        implicit: {
          authorizationUrl: 'https://auth.example.com',
          scopes: {},
        },
      },
    };

    expect(registry.getProvider(authSchemeOauth2)).toBeUndefined();
  });

  it('should override previous provider if registered again with same type', () => {
    const registry = new AuthProviderRegistry();
    const mockProvider1 = new MockAuthProvider();
    const mockProvider2 = new MockAuthProvider();

    registry.register('apiKey', mockProvider1);
    registry.register('apiKey', mockProvider2);

    const authScheme: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    expect(registry.getProvider(authScheme)).toBe(mockProvider2);
  });

  it('should isolate registry instances', () => {
    const registry1 = new AuthProviderRegistry();
    const registry2 = new AuthProviderRegistry();

    const mockProvider1 = new MockAuthProvider();
    const mockProvider2 = new MockAuthProvider();

    registry1.register('apiKey', mockProvider1);
    registry2.register('oauth2', mockProvider2);

    const authSchemeApiKey: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    const authSchemeOauth2: AuthScheme = {
      type: 'oauth2',
      flows: {
        implicit: {
          authorizationUrl: 'https://auth.example.com',
          scopes: {},
        },
      },
    };

    expect(registry1.getProvider(authSchemeApiKey)).toBe(mockProvider1);
    expect(registry1.getProvider(authSchemeOauth2)).toBeUndefined();

    expect(registry2.getProvider(authSchemeOauth2)).toBe(mockProvider2);
    expect(registry2.getProvider(authSchemeApiKey)).toBeUndefined();
  });
});
