/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python v0.1.0:
// src/google/adk/tests/unittests/tools/openapi_tool/auth/credential_exchangers/test_service_account_exchanger.py
//
// Four of the five reference tests port, under adk-js naming:
//   test_exchange_credential_success
//     -> 'should exchange explicit key material for a bearer token'
//   test_exchange_credential_use_default_credential_success
//     -> 'should exchange application default credentials for a bearer token'
//   test_exchange_credential_missing_service_account_info
//     -> 'should report the missing credentials when serviceAccount is absent'
//   test_exchange_credential_exchange_failure
//     -> 'should wrap a failure from the JWT client'
//
// test_exchange_credential_missing_auth_credential does not port. adk-python's
// parameter defaults to `None`, and adk-js declares `authCredential` as
// required on `BaseCredentialExchanger`, so no caller reaches that state
// without defeating the type. Both Python cases assert the same message from
// the same guard, which 'should report the missing credentials when
// serviceAccount is absent' pins here.

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  ServiceAccountCredential,
} from '@google/adk';
import {GoogleAuth, JWT} from 'google-auth-library';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {ServiceAccountCredentialExchanger} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

vi.mock('google-auth-library', () => ({
  JWT: vi.fn().mockImplementation(() => ({
    authorize: vi.fn().mockResolvedValue({access_token: 'mock_access_token'}),
  })),
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue({token: 'mock_access_token'}),
    }),
  })),
}));

/** Replaces the next `JWT` with one whose `authorize` behaves as given. */
function stubJwtOnce(authorize: Mock): void {
  vi.mocked(JWT).mockImplementationOnce(() => ({authorize}) as unknown as JWT);
}

/** Mirrors the ten-field service account block the reference test builds. */
function serviceAccountCredential(): ServiceAccountCredential {
  return {
    type: 'service_account',
    projectId: 'your_project_id',
    privateKeyId: 'your_private_key_id',
    privateKey: '-----BEGIN PRIVATE KEY-----...',
    clientEmail: '...@....iam.gserviceaccount.com',
    clientId: 'your_client_id',
    authUri: 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token',
    authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
    clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/...',
    universeDomain: 'googleapis.com',
  };
}

function explicitCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    serviceAccount: {
      serviceAccountCredential: serviceAccountCredential(),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  };
}

describe('ServiceAccountCredentialExchanger (adk-python v0.1.0 parity)', () => {
  let exchanger: ServiceAccountCredentialExchanger;

  beforeEach(() => {
    vi.mocked(JWT).mockClear();
    vi.mocked(GoogleAuth).mockClear();
    exchanger = new ServiceAccountCredentialExchanger();
  });

  it('should exchange explicit key material for a bearer token', async () => {
    const result = await exchanger.exchange({
      authCredential: explicitCredential(),
    });

    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.scheme).toBe('bearer');
    expect(result.credential.http?.credentials.token).toBe('mock_access_token');
    expect(JWT).toHaveBeenCalledTimes(1);
    expect(GoogleAuth).not.toHaveBeenCalled();
  });

  it('should exchange application default credentials for a bearer token', async () => {
    const result = await exchanger.exchange({
      authCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {
          useDefaultCredential: true,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      },
    });

    expect(result.credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(result.credential.http?.scheme).toBe('bearer');
    expect(result.credential.http?.credentials.token).toBe('mock_access_token');
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
    expect(JWT).not.toHaveBeenCalled();
  });

  it('should report the missing credentials when serviceAccount is absent', async () => {
    await expect(
      exchanger.exchange({
        authCredential: {authType: AuthCredentialTypes.SERVICE_ACCOUNT},
      }),
    ).rejects.toThrow('Service account credentials are missing');
  });

  // The TYPE, not just the message. Every other assertion in this file pins the
  // text, which is why the error class could change twice without a single test
  // noticing -- and why it could change back just as quietly.
  it('throws AuthCredentialMissingError, the type adk-python raises', async () => {
    await expect(
      exchanger.exchange({
        authCredential: {authType: AuthCredentialTypes.SERVICE_ACCOUNT},
      }),
    ).rejects.toThrow(AuthCredentialMissingError);
  });

  // `serviceAccount` present, but neither `serviceAccountCredential` nor
  // `useDefaultCredential`. This reaches the throw through `exchange()` rather
  // than the guard that fronts it, and had no test at all before or after the
  // fix -- which is exactly what made it easy to miss.
  it('throws AuthCredentialMissingError when neither key material nor the default flag is set', async () => {
    await expect(
      exchanger.exchange({
        authCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {scopes: []},
        },
      }),
    ).rejects.toThrow(AuthCredentialMissingError);
  });

  it('should wrap a failure from the JWT client', async () => {
    stubJwtOnce(
      vi.fn().mockRejectedValue(new Error('Failed to load credentials')),
    );

    // adk-python reports `Failed to exchange service account token`. adk-js
    // names the path it took, and that extra word is kept.
    // One rejection, asserted twice: `stubJwtOnce` only stubs the next call,
    // so a second `exchange()` would take the success mock.
    const failed = exchanger.exchange({authCredential: explicitCredential()});
    await expect(failed).rejects.toThrow(
      'Failed to exchange explicit service account token: Failed to load credentials',
    );
    // The TYPE, not only the message. Asserting the message alone let this
    // site sit on the wrong error class for two review rounds: reverting it to
    // `CredentialExchangeError` kept every test green.
    await expect(failed).rejects.toThrow(AuthCredentialMissingError);
    expect(JWT).toHaveBeenCalledTimes(1);
  });

  it('wraps a failure from the default-credential path', async () => {
    // The other catch-all (`service_account_exchanger.ts:97`), which had no
    // test at all -- the only `GoogleAuth` coverage was the success case, so
    // this branch could have thrown anything.
    vi.mocked(GoogleAuth).mockImplementationOnce(
      () =>
        ({
          getClient: vi.fn().mockResolvedValue({
            getAccessToken: vi
              .fn()
              .mockRejectedValue(new Error('metadata server unreachable')),
          }),
        }) as unknown as GoogleAuth,
    );

    await expect(
      exchanger.exchange({
        authCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {
            useDefaultCredential: true,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        },
      }),
    ).rejects.toThrow(AuthCredentialMissingError);
    expect(GoogleAuth).toHaveBeenCalledTimes(1);
  });
});
