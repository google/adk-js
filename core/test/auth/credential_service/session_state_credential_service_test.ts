/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  SessionStateCredentialService,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('SessionStateCredentialService', () => {
  it('should load credential from state', async () => {
    const service = new SessionStateCredentialService();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret',
    };

    const mockState = {
      get: vi.fn().mockReturnValue(credential),
      set: vi.fn(),
    };

    const mockContext = {
      state: mockState,
    } as unknown as Context;

    const authConfig: AuthConfig = {
      credentialKey: 'my-key',
      authScheme: {} as AuthScheme,
    };

    const result = await service.loadCredential(authConfig, mockContext);

    expect(result).toEqual(credential);
    expect(mockState.get).toHaveBeenCalledWith('my-key');
  });

  it('should return undefined if not in state', async () => {
    const service = new SessionStateCredentialService();

    const mockState = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    };

    const mockContext = {
      state: mockState,
    } as unknown as Context;

    const authConfig: AuthConfig = {
      credentialKey: 'my-key',
      authScheme: {} as AuthScheme,
    };

    const result = await service.loadCredential(authConfig, mockContext);

    expect(result).toBeUndefined();
    expect(mockState.get).toHaveBeenCalledWith('my-key');
  });

  it('should save credential to state', async () => {
    const service = new SessionStateCredentialService();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret',
    };

    const mockState = {
      get: vi.fn(),
      set: vi.fn(),
    };

    const mockContext = {
      state: mockState,
    } as unknown as Context;

    const authConfig: AuthConfig = {
      credentialKey: 'my-key',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: credential,
    };

    await service.saveCredential(authConfig, mockContext);

    expect(mockState.set).toHaveBeenCalledWith('my-key', credential);
  });

  it('should skip saving if no exchangedAuthCredential', async () => {
    const service = new SessionStateCredentialService();

    const mockState = {
      get: vi.fn(),
      set: vi.fn(),
    };

    const mockContext = {
      state: mockState,
    } as unknown as Context;

    const authConfig: AuthConfig = {
      credentialKey: 'my-key',
      authScheme: {} as AuthScheme,
    };

    await service.saveCredential(authConfig, mockContext);

    expect(mockState.set).not.toHaveBeenCalled();
  });
});
