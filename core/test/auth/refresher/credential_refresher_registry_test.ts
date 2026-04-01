/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseCredentialRefresher,
  CredentialRefresherRegistry,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// Mock credential refresher for testing
class MockRefresher implements BaseCredentialRefresher {
  async isRefreshNeeded(_authCredential: AuthCredential): Promise<boolean> {
    return false;
  }

  async refresh(authCredential: AuthCredential): Promise<AuthCredential> {
    return authCredential;
  }
}

describe('CredentialRefresherRegistry', () => {
  it('should initialize with an empty refreshers dictionary', () => {
    const registry = new CredentialRefresherRegistry();

    expect(registry.getRefresher(AuthCredentialTypes.OAUTH2)).toBeUndefined();
  });

  it('should register a single refresher', () => {
    const registry = new CredentialRefresherRegistry();
    const mockRefresher = new MockRefresher();

    registry.register(AuthCredentialTypes.OAUTH2, mockRefresher);

    const retrievedRefresher = registry.getRefresher(
      AuthCredentialTypes.OAUTH2,
    );
    expect(retrievedRefresher).toBe(mockRefresher);
  });

  it('Should register all credential types', () => {
    const registry = new CredentialRefresherRegistry();

    const mockRefresherApiKey = new MockRefresher();
    const mockRefresherOauth2 = new MockRefresher();
    const mockRefresherOpenIdConnect = new MockRefresher();
    const mockRefresherServiceAccount = new MockRefresher();

    registry.register(AuthCredentialTypes.API_KEY, mockRefresherApiKey);
    registry.register(AuthCredentialTypes.OAUTH2, mockRefresherOauth2);
    registry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      mockRefresherOpenIdConnect,
    );
    registry.register(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      mockRefresherServiceAccount,
    );

    expect(registry.getRefresher(AuthCredentialTypes.API_KEY)).toBe(
      mockRefresherApiKey,
    );
    expect(registry.getRefresher(AuthCredentialTypes.OAUTH2)).toBe(
      mockRefresherOauth2,
    );
    expect(registry.getRefresher(AuthCredentialTypes.OPEN_ID_CONNECT)).toBe(
      mockRefresherOpenIdConnect,
    );
    expect(registry.getRefresher(AuthCredentialTypes.SERVICE_ACCOUNT)).toBe(
      mockRefresherServiceAccount,
    );
  });

  it('Should return undefined for a not registered credential type', () => {
    const registry = new CredentialRefresherRegistry();
    const mockRefresherApiKey = new MockRefresher();

    registry.register(AuthCredentialTypes.API_KEY, mockRefresherApiKey);

    expect(registry.getRefresher(AuthCredentialTypes.API_KEY)).toBe(
      mockRefresherApiKey,
    );
    expect(registry.getRefresher(AuthCredentialTypes.OAUTH2)).toBeUndefined();
  });

  it('Should isolate registry instances', () => {
    const registry1 = new CredentialRefresherRegistry();
    const registry2 = new CredentialRefresherRegistry();

    const mockRefresherApiKey = new MockRefresher();
    const mockRefresherOauth2 = new MockRefresher();

    registry1.register(AuthCredentialTypes.API_KEY, mockRefresherApiKey);
    registry2.register(AuthCredentialTypes.OAUTH2, mockRefresherOauth2);

    expect(registry1.getRefresher(AuthCredentialTypes.API_KEY)).toBe(
      mockRefresherApiKey,
    );
    expect(registry1.getRefresher(AuthCredentialTypes.OAUTH2)).toBeUndefined();
    expect(registry2.getRefresher(AuthCredentialTypes.OAUTH2)).toBe(
      mockRefresherOauth2,
    );
    expect(registry2.getRefresher(AuthCredentialTypes.API_KEY)).toBeUndefined();
  });
});
