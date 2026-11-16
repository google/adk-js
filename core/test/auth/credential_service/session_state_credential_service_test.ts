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
  State,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

/** A context whose session state is a real {@link State}. */
function createStateContext(state = new State()): Context {
  return {state} as unknown as Context;
}

/** An OAuth2 credential with the given client id. */
function createOAuth2Credential(clientId: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId,
      clientSecret: `${clientId}-secret`,
      redirectUri: 'https://example.com/callback',
    },
  };
}

/** Returns a copy of `credential` without `oauth2.clientSecret`. */
function withoutClientSecret(credential: AuthCredential): AuthCredential {
  if (!credential.oauth2) {
    return credential;
  }
  const {clientSecret: _secret, ...oauth2} = credential.oauth2;
  return {...credential, oauth2};
}

/** An auth config whose exchanged credential is the given credential. */
function createAuthConfig({
  credentialKey = 'my-key',
  credential = createOAuth2Credential('mock_client_id'),
}: {credentialKey?: string; credential?: AuthCredential} = {}): AuthConfig {
  return {
    credentialKey,
    authScheme: {} as AuthScheme,
    rawAuthCredential: credential,
    exchangedAuthCredential: credential,
  };
}

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

  it('replaces a saved credential when the same key is saved again', async () => {
    const service = new SessionStateCredentialService();
    const context = createStateContext();
    const authConfig = createAuthConfig();
    await service.saveCredential(authConfig, context);

    const updated: AuthConfig = {
      ...authConfig,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'updated_client_id',
          clientSecret: 'updated_client_secret',
          redirectUri: 'https://updated.com/callback',
        },
      },
    };
    await service.saveCredential(updated, context);

    const result = await service.loadCredential(updated, context);
    expect(result?.oauth2?.clientId).toBe('updated_client_id');
    expect(result?.oauth2?.redirectUri).toBe('https://updated.com/callback');
    expect(result?.oauth2?.clientSecret).toBe('mock_client_id-secret');
  });

  it('keeps credentials of different session states apart', async () => {
    const service = new SessionStateCredentialService();
    const authConfig = createAuthConfig();
    const context = createStateContext();
    const otherContext = createStateContext();

    await service.saveCredential(authConfig, context);

    expect(
      await service.loadCredential(authConfig, otherContext),
    ).toBeUndefined();
    expect(await service.loadCredential(authConfig, context)).toEqual(
      authConfig.exchangedAuthCredential,
    );
  });

  it('stores credentials under different keys in separate slots', async () => {
    const service = new SessionStateCredentialService();
    const context = createStateContext();
    const config1 = createAuthConfig({
      credentialKey: 'key1',
      credential: createOAuth2Credential('client1'),
    });
    const config2 = createAuthConfig({
      credentialKey: 'key2',
      credential: createOAuth2Credential('client2'),
    });

    await service.saveCredential(config1, context);
    expect(await service.loadCredential(config2, context)).toBeUndefined();

    await service.saveCredential(config2, context);
    expect(
      (await service.loadCredential(config1, context))?.oauth2?.clientId,
    ).toBe('client1');
    expect(
      (await service.loadCredential(config2, context))?.oauth2?.clientId,
    ).toBe('client2');
  });

  it('saves and loads a credential under an empty key', async () => {
    const service = new SessionStateCredentialService();
    const context = createStateContext();
    const authConfig = createAuthConfig({credentialKey: ''});

    await service.saveCredential(authConfig, context);

    expect(await service.loadCredential(authConfig, context)).toEqual(
      authConfig.exchangedAuthCredential,
    );
  });

  it('reflects each save in later loads from the same state', async () => {
    const service = new SessionStateCredentialService();
    const state = new State();
    const context = createStateContext(state);
    const authConfig = createAuthConfig();
    const initialCredential = authConfig.exchangedAuthCredential!;

    expect(await service.loadCredential(authConfig, context)).toBeUndefined();

    await service.saveCredential(authConfig, context);
    expect(state.get(authConfig.credentialKey)).toEqual(
      withoutClientSecret(initialCredential),
    );
    expect(await service.loadCredential(authConfig, context)).toEqual(
      initialCredential,
    );
    expect(state.get(authConfig.credentialKey)).toEqual(
      withoutClientSecret(initialCredential),
    );

    const newCredential = createOAuth2Credential('new_client_id');
    await service.saveCredential(
      {...authConfig, exchangedAuthCredential: newCredential},
      context,
    );
    expect(state.get(authConfig.credentialKey)).toEqual(
      withoutClientSecret(newCredential),
    );
    expect(
      (await service.loadCredential(authConfig, context))?.oauth2?.clientId,
    ).toBe('new_client_id');
  });

  it('writes the credential to session state under the credential key', async () => {
    const service = new SessionStateCredentialService();
    const state = new State();
    const context = createStateContext(state);
    const authConfig = createAuthConfig();

    state.set(authConfig.credentialKey, {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'direct_client_id',
        clientSecret: 'direct_client_secret',
        redirectUri: 'https://direct.com/callback',
      },
    } satisfies AuthCredential);

    const loaded = await service.loadCredential(authConfig, context);
    expect(loaded?.oauth2?.clientId).toBe('direct_client_id');
    expect(loaded?.oauth2?.redirectUri).toBe('https://direct.com/callback');
    expect(loaded?.oauth2?.clientSecret).toBe('mock_client_id-secret');

    await service.saveCredential(authConfig, context);
    expect(state.get(authConfig.credentialKey)).toEqual(
      withoutClientSecret(authConfig.exchangedAuthCredential!),
    );
  });

  it('strips the OAuth2 client secret before writing to session state', async () => {
    const service = new SessionStateCredentialService();
    const state = new State();
    const authConfig: AuthConfig = {
      ...createAuthConfig(),
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'test-client-id',
          clientSecret: 'test-super-secret',
          accessToken: 'mock-access',
          refreshToken: 'mock-refresh',
        },
      },
    };

    await service.saveCredential(authConfig, createStateContext(state));

    const stored = state.get<AuthCredential>(authConfig.credentialKey);
    expect(stored?.oauth2?.clientSecret).toBeUndefined();
    expect(stored?.oauth2?.accessToken).toBe('mock-access');
    expect(stored?.oauth2?.refreshToken).toBe('mock-refresh');
    expect(JSON.stringify(state.toRecord())).not.toContain('test-super-secret');
  });

  it('does not mutate the caller credential when stripping the client secret', async () => {
    const service = new SessionStateCredentialService();
    const exchanged: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'cid',
        clientSecret: 'still-needed',
        accessToken: 'mock-access',
      },
    };
    const authConfig: AuthConfig = {
      ...createAuthConfig(),
      exchangedAuthCredential: exchanged,
    };

    await service.saveCredential(authConfig, createStateContext());

    expect(exchanged.oauth2?.clientSecret).toBe('still-needed');
    expect(authConfig.exchangedAuthCredential?.oauth2?.clientSecret).toBe(
      'still-needed',
    );
  });

  it('restores the configured client secret on load without mutating state', async () => {
    const service = new SessionStateCredentialService();
    const state = new State();
    const context = createStateContext(state);
    const rawAuthCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'test-client-id',
        clientSecret: 'test-configured-secret',
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'my-key',
      authScheme: {} as AuthScheme,
      rawAuthCredential,
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {
          clientId: 'test-client-id',
          clientSecret: 'test-configured-secret',
          accessToken: 'mock-access',
          refreshToken: 'mock-refresh',
        },
      },
    };

    await service.saveCredential(authConfig, context);
    const result = await service.loadCredential(authConfig, context);

    expect(result?.oauth2?.clientSecret).toBe('test-configured-secret');
    expect(result?.oauth2?.accessToken).toBe('mock-access');
    expect(result?.oauth2?.refreshToken).toBe('mock-refresh');
    expect(
      state.get<AuthCredential>(authConfig.credentialKey)?.oauth2?.clientSecret,
    ).toBeUndefined();
  });

  it('ignores non-credential values stored under the credential key', async () => {
    const service = new SessionStateCredentialService();
    const state = new State();
    const authConfig = createAuthConfig();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    state.set(authConfig.credentialKey, 'mock-access');

    const result = await service.loadCredential(
      authConfig,
      createStateContext(state),
    );

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Ignoring string stored under the credential key',
      ),
    );
    warnSpy.mockRestore();
  });
});
