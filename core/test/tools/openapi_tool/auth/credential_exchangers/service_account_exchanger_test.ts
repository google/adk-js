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
import {createVerify, generateKeyPairSync} from 'node:crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  MockInstance,
  vi,
} from 'vitest';
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

describe('ServiceAccountCredentialExchanger custom token URI', () => {
  const customTokenUri = 'https://sts.example.com/token';
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
    publicKeyEncoding: {type: 'spki', format: 'pem'},
  });

  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    vi.mocked(JWT).mockClear();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({access_token: 'custom_access_token'}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function customCredential(): AuthCredential {
    return {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          ...serviceAccountCredential(),
          privateKey,
          clientEmail: 'robot@example.iam.gserviceaccount.com',
          tokenUri: customTokenUri,
        },
        scopes: ['scope-a', 'scope-b'],
      },
    };
  }

  /** Returns the URL and the form body of the single token request. */
  function tokenRequest(): {url: string; form: URLSearchParams} {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe('POST');
    return {url: String(url), form: new URLSearchParams(String(init?.body))};
  }

  function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  }

  it('posts a JWT-bearer grant to the custom token URI', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();

    await exchanger.exchange({authCredential: customCredential()});

    const {url, form} = tokenRequest();
    expect(url).toBe(customTokenUri);
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    expect(JWT).not.toHaveBeenCalled();
  });

  it('signs an assertion that verifies against the public key', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();

    await exchanger.exchange({authCredential: customCredential()});

    const assertion = tokenRequest().form.get('assertion') ?? '';
    const [header, payload, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, 'base64url');
    expect(verified).toBe(true);

    expect(decodeSegment(header)).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'your_private_key_id',
    });
    const claims = decodeSegment(payload);
    expect(claims).toMatchObject({
      iss: 'robot@example.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'scope-a scope-b',
    });
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(3600);
  });

  it('returns the token from the custom endpoint as a bearer credential', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();

    const result = await exchanger.exchange({
      authCredential: customCredential(),
    });

    expect(result).toEqual({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'custom_access_token'}},
      },
      wasExchanged: true,
    });
  });

  it('reports a non-2xx response as missing credentials', async () => {
    fetchSpy.mockResolvedValue(new Response('denied', {status: 401}));
    const exchanger = new ServiceAccountCredentialExchanger();

    const exchange = exchanger.exchange({authCredential: customCredential()});

    await expect(exchange).rejects.toBeInstanceOf(AuthCredentialMissingError);
    await expect(exchange).rejects.toThrow('HTTP 401');
  });

  it('includes error and error_description from a failed JSON token response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid JWT signature.',
        }),
        {status: 400, headers: {'Content-Type': 'application/json'}},
      ),
    );
    const exchanger = new ServiceAccountCredentialExchanger();

    const exchange = exchanger.exchange({authCredential: customCredential()});

    await expect(exchange).rejects.toBeInstanceOf(AuthCredentialMissingError);
    await expect(exchange).rejects.toThrow(
      'HTTP 400: invalid_grant: Invalid JWT signature.',
    );
  });

  it('reports a response without an access token as missing credentials', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({token_type: 'Bearer'}), {status: 200}),
    );
    const exchanger = new ServiceAccountCredentialExchanger();

    await expect(
      exchanger.exchange({authCredential: customCredential()}),
    ).rejects.toBeInstanceOf(AuthCredentialMissingError);
  });

  it('bounds the token request with a 30 second timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const exchanger = new ServiceAccountCredentialExchanger();

    try {
      await exchanger.exchange({authCredential: customCredential()});

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      const [, init] = fetchSpy.mock.calls[0];
      expect(init?.signal).toBe(timeoutSpy.mock.results[0].value);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('reports a timed-out token request as missing credentials', async () => {
    fetchSpy.mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    const exchanger = new ServiceAccountCredentialExchanger();

    const exchange = exchanger.exchange({authCredential: customCredential()});

    await expect(exchange).rejects.toBeInstanceOf(AuthCredentialMissingError);
    await expect(exchange).rejects.toThrow('The operation timed out.');
  });

  it('keeps using the JWT client for the default token URI', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();

    const result = await exchanger.exchange({
      authCredential: explicitCredential(),
    });

    expect(JWT).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.credential.http?.credentials?.token).toBe(
      'mock_access_token',
    );
  });
});
