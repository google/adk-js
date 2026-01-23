/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../src/auth/auth_schemes.js';
import {BaseCredentialExchanger} from '../../../src/auth/exchanger/base_credential_exchanger.js';
import {CredentialExchangerRegistry} from '../../../src/auth/exchanger/credential_exchanger_registry.js';

// Mock credential exchanger for testing
class MockCredentialExchanger implements BaseCredentialExchanger {
  async exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<AuthCredential> {
    return authCredential;
  }
}

describe('CredentialExchangerRegistry', () => {
  it('should initialize with an empty exchangers dictionary', () => {
    const registry = new CredentialExchangerRegistry();

    // Since exchangers is private, test indirectly by trying to get an exchanger
    // All credential types should return undefined when registry is empty
    expect(registry.getExchanger(AuthCredentialTypes.OAUTH2)).toBeUndefined();
  });

  it('should register a single exchanger', () => {
    const registry = new CredentialExchangerRegistry();
    const mockExchanger = new MockCredentialExchanger();

    registry.register(AuthCredentialTypes.API_KEY, mockExchanger);

    // Verify the exchanger was registered
    const retrievedExchanger = registry.getExchanger(
      AuthCredentialTypes.API_KEY,
    );
    expect(retrievedExchanger).toBe(mockExchanger);
  });

  it('Should register all credential types', () => {
    const registry = new CredentialExchangerRegistry();

    // Register all credential types
    const mockExchangerApiKey = new MockCredentialExchanger();
    const mockExchangerOauth2 = new MockCredentialExchanger();
    const mockExchangerOpenIdConnect = new MockCredentialExchanger();
    const mockExchangerServiceAccount = new MockCredentialExchanger();

    // Register each credential type
    registry.register(AuthCredentialTypes.API_KEY, mockExchangerApiKey);
    registry.register(AuthCredentialTypes.OAUTH2, mockExchangerOauth2);
    registry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      mockExchangerOpenIdConnect,
    );
    registry.register(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      mockExchangerServiceAccount,
    );

    // Verify each credential type was registered
    expect(registry.getExchanger(AuthCredentialTypes.API_KEY)).toBe(
      mockExchangerApiKey,
    );
    expect(registry.getExchanger(AuthCredentialTypes.OAUTH2)).toBe(
      mockExchangerOauth2,
    );
    expect(registry.getExchanger(AuthCredentialTypes.OPEN_ID_CONNECT)).toBe(
      mockExchangerOpenIdConnect,
    );
    expect(registry.getExchanger(AuthCredentialTypes.SERVICE_ACCOUNT)).toBe(
      mockExchangerServiceAccount,
    );
  });

  it('Should return undefined for an not registered credential type', () => {
    const registry = new CredentialExchangerRegistry();
    const mockExchangerApiKey = new MockCredentialExchanger();

    registry.register(AuthCredentialTypes.API_KEY, mockExchangerApiKey);

    // Verify the exchanger with API key is registered and undefined for OAuth2
    expect(registry.getExchanger(AuthCredentialTypes.API_KEY)).toBe(
      mockExchangerApiKey,
    );
    expect(registry.getExchanger(AuthCredentialTypes.OAUTH2)).toBeUndefined();
  });

  it('Should isolate registry instances', () => {
    const registry1 = new CredentialExchangerRegistry();
    const registry2 = new CredentialExchangerRegistry();

    const mockExchangerApiKey = new MockCredentialExchanger();
    const mockExchangerOauth2 = new MockCredentialExchanger();

    // Register different credential types for different registries
    registry1.register(AuthCredentialTypes.API_KEY, mockExchangerApiKey);
    registry2.register(AuthCredentialTypes.OAUTH2, mockExchangerOauth2);

    // Verify each registry has the correct exchanger  and undefined for the other credential type
    expect(registry1.getExchanger(AuthCredentialTypes.API_KEY)).toBe(
      mockExchangerApiKey,
    );
    expect(registry1.getExchanger(AuthCredentialTypes.OAUTH2)).toBeUndefined();
    expect(registry2.getExchanger(AuthCredentialTypes.OAUTH2)).toBe(
      mockExchangerOauth2,
    );
    expect(registry2.getExchanger(AuthCredentialTypes.API_KEY)).toBeUndefined();
  });
});
