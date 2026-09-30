/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * tests/unittests/tools/openapi_tool/auth/credential_exchangers/test_auto_auth_credential_exchanger.py
 * at tag v0.1.0.
 *
 * Test names are kept verbatim from the Python originals so a reviewer can
 * grep for them.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  AutoAuthCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
  OAuth2CredentialExchanger,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const authScheme: AuthScheme = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const exchangedCredential: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'exchanged-token'}},
};

function credentialOf(authType: AuthCredentialTypes): AuthCredential {
  return {authType};
}

/**
 * A mock exchanger, typed as the parameter the class accepts so that the call
 * assertions are checked rather than widened.
 */
function createMockExchanger(credential: AuthCredential) {
  return {
    exchange: vi.fn(
      async (_params: {
        authScheme?: AuthScheme;
        authCredential: AuthCredential;
      }): Promise<ExchangeResult> => ({credential, wasExchanged: true}),
    ),
  };
}

function spyOnDefaultOAuth2Exchanger() {
  return vi
    .spyOn(OAuth2CredentialExchanger.prototype, 'exchange')
    .mockResolvedValue({credential: exchangedCredential, wasExchanged: true});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutoAuthCredentialExchanger ported from adk-python v0.1.0', () => {
  it('test_init_with_custom_exchangers', async () => {
    const customExchanger = createMockExchanger(exchangedCredential);
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.API_KEY]: customExchanger,
    });

    const apiKeyResult = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.API_KEY),
    });
    const openIdResult = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    // The custom exchanger is registered for API_KEY.
    expect(customExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(apiKeyResult.credential).toBe(exchangedCredential);
    // The OPEN_ID_CONNECT default survives the merge.
    expect(oauth2Spy).toHaveBeenCalledTimes(1);
    expect(openIdResult.credential).toBe(exchangedCredential);
  });

  it('test_exchange_credential_no_auth_credential', async () => {
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger();

    const result = await autoExchanger.exchange({
      authScheme,
      authCredential: undefined,
    });

    expect(result).toBeNull();
    expect(oauth2Spy).not.toHaveBeenCalled();
  });

  it('test_exchange_credential_no_exchange', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();
    const authCredential = credentialOf(AuthCredentialTypes.API_KEY);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    // adk-python returns the bare credential; adk-js wraps it and reports that
    // no exchange happened, so the caller can still tell the two apart.
    expect(result).toEqual({credential: authCredential, wasExchanged: false});
  });

  it('test_exchange_credential_open_id_connect', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OPEN_ID_CONNECT]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });

  it('test_exchange_credential_service_account', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.SERVICE_ACCOUNT]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.SERVICE_ACCOUNT);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });

  it('test_exchange_credential_custom_exchanger', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.API_KEY]: mockExchanger,
    });
    const authCredential = credentialOf(AuthCredentialTypes.API_KEY);

    const result = await autoExchanger.exchange({authScheme, authCredential});

    expect(result).toEqual({
      credential: exchangedCredential,
      wasExchanged: true,
    });
    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(mockExchanger.exchange).toHaveBeenCalledWith({
      authScheme,
      authCredential,
    });
  });
});

describe('AutoAuthCredentialExchanger adk-js specific behaviour', () => {
  it('keeps the default when a custom entry is undefined', async () => {
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OPEN_ID_CONNECT]: undefined,
    });

    const result = await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    expect(oauth2Spy).toHaveBeenCalledTimes(1);
    expect(result.credential).toBe(exchangedCredential);
  });

  it('overrides one type without disturbing the other defaults', async () => {
    const mockExchanger = createMockExchanger(exchangedCredential);
    const oauth2Spy = spyOnDefaultOAuth2Exchanger();
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.SERVICE_ACCOUNT]: mockExchanger,
    });

    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.SERVICE_ACCOUNT),
    });
    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OAUTH2),
    });
    await autoExchanger.exchange({
      authScheme,
      authCredential: credentialOf(AuthCredentialTypes.OPEN_ID_CONNECT),
    });

    expect(mockExchanger.exchange).toHaveBeenCalledTimes(1);
    expect(oauth2Spy).toHaveBeenCalledTimes(2);
  });

  it('resolves to null when the call omits authCredential', async () => {
    const autoExchanger = new AutoAuthCredentialExchanger();

    await expect(autoExchanger.exchange({})).resolves.toBeNull();
  });

  it('propagates an error from the delegated exchanger unwrapped', async () => {
    const failure = new CredentialExchangeError('token endpoint refused');
    const failingExchanger = {
      exchange: vi.fn(
        async (_params: {
          authScheme?: AuthScheme;
          authCredential: AuthCredential;
        }): Promise<ExchangeResult> => {
          throw failure;
        },
      ),
    };
    const autoExchanger = new AutoAuthCredentialExchanger({
      [AuthCredentialTypes.OAUTH2]: failingExchanger,
    });

    await expect(
      autoExchanger.exchange({
        authScheme,
        authCredential: credentialOf(AuthCredentialTypes.OAUTH2),
      }),
    ).rejects.toBe(failure);
  });
});
