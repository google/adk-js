/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {CredentialManager} from '../../src/auth/credential_manager.js';
import {BaseCredentialService} from '../../src/auth/credential_service/base_credential_service.js';

describe('CredentialManager', () => {
  it('falls back to context getAuthResponse when service is empty', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };
    const mockCredential = {authType: AuthCredentialTypes.OAUTH2};

    const manager = new CredentialManager(mockAuthConfig as any);

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(mockCredential),
    } as unknown as Context;

    const result = await manager.getAuthCredential(mockContext);

    expect(result).toEqual(mockCredential);
    expect(mockContext.getAuthResponse).toHaveBeenCalledWith(mockAuthConfig);
  });

  it('loads from CredentialService if available', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };
    const mockCredential = {authType: AuthCredentialTypes.OAUTH2};

    const manager = new CredentialManager(mockAuthConfig as any);

    const mockService = {
      loadCredential: vi.fn().mockResolvedValue(mockCredential),
      saveCredential: vi.fn(),
    } as unknown as BaseCredentialService;

    const mockContext = {
      invocationContext: {credentialService: mockService},
      getAuthResponse: vi.fn(),
    } as unknown as Context;

    const result = await manager.getAuthCredential(mockContext);

    expect(result).toEqual(mockCredential);
    expect(mockService.loadCredential).toHaveBeenCalledWith(
      mockAuthConfig,
      mockContext,
    );
    expect(mockContext.getAuthResponse).not.toHaveBeenCalled();
  });

  it('exchanges credential if needed', async () => {
    const mockAuthConfig = {
      authScheme: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
          },
        },
      },
      credentialKey: 'test-key',
      rawAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          authCode: 'code',
        },
      },
    };
    const mockCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authCode: 'code',
      },
    };

    const manager = new CredentialManager(mockAuthConfig as any);

    // Mock exchanger registry or use the default OAuth2 exchanger if we can mock its fetch
    // For simplicity, let's mock getExchanger on the internal registry if we can, but it's private.
    // So we'll let it use the default OAuth2Exchanger, but mock the fetch inside it!
    // Since fetch is global in Node 18+, we can mock global.fetch!
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'exchanged_token',
          expires_in: 3600,
        }),
      }),
    );

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(mockCredential),
    } as unknown as Context;

    const result = await manager.getAuthCredential(mockContext);

    expect(result?.oauth2?.accessToken).toEqual('exchanged_token');
  });

  it('returns undefined if token is expired', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };
    const mockCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {expiresAt: Date.now() - 1000}, // Expired
    };

    const manager = new CredentialManager(mockAuthConfig as any);

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(mockCredential),
    } as unknown as Context;

    const result = await manager.getAuthCredential(mockContext);

    expect(result).toBeUndefined();
  });

  it('saves to CredentialService when modified', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
      rawAuthCredential: {authType: AuthCredentialTypes.OAUTH2},
    };
    const mockCredential = {authType: AuthCredentialTypes.OAUTH2};

    const manager = new CredentialManager(mockAuthConfig as any);

    const mockService = {
      loadCredential: vi.fn().mockResolvedValue(undefined), // Load fails
      saveCredential: vi.fn(),
    } as unknown as BaseCredentialService;

    const mockContext = {
      invocationContext: {credentialService: mockService},
      getAuthResponse: vi.fn().mockReturnValue(mockCredential), // Fallback succeeds
    } as unknown as Context;

    await manager.getAuthCredential(mockContext);

    expect(mockService.saveCredential).toHaveBeenCalled();
  });
});
