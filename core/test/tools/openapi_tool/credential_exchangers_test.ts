/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {describe, expect, it, Mock, vi} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccountCredential,
} from '../../../src/auth/auth_credential.js';
import {AutoAuthCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {ServiceAccountCredentialExchanger} from '../../../src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.js';

vi.mock('google-auth-library', () => {
  return {
    JWT: vi.fn().mockImplementation(() => ({
      authorize: vi.fn().mockResolvedValue({access_token: 'mock-token'}),
    })),
    GoogleAuth: vi.fn().mockImplementation(() => ({
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({token: 'mock-adc-token'}),
      }),
    })),
  };
});

/** A whole service account JSON file, in the camelCase spelling adk-js uses. */
function fullServiceAccountCredential(): ServiceAccountCredential {
  return {
    type: 'service_account',
    projectId: 'my-project',
    privateKeyId: 'abc123',
    privateKey: '-----BEGIN PRIVATE KEY-----...',
    clientEmail: 'agent@my-project.iam.gserviceaccount.com',
    clientId: '1234',
    authUri: 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: 'https://oauth2.googleapis.com/token',
    authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
    clientX509CertUrl: 'https://www.googleapis.com/robot/v1/metadata/x509/...',
    universeDomain: 'googleapis.com',
  };
}

/** Replaces the next `GoogleAuth` with one whose `getClient` behaves as given. */
function stubGoogleAuthOnce(getClient: Mock): void {
  vi.mocked(GoogleAuth).mockImplementationOnce(
    () => ({getClient}) as unknown as GoogleAuth,
  );
}

describe('AutoAuthCredentialExchanger', () => {
  it('should return original credential if no exchanger registered', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const credential = {authType: AuthCredentialTypes.API_KEY, apiKey: 'key'};

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.wasExchanged).toBe(false);
    expect(result.credential).toEqual(credential);
  });

  it('should use ServiceAccountCredentialExchanger for serviceAccount', async () => {
    const exchanger = new AutoAuthCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });
});

describe('ServiceAccountCredentialExchanger', () => {
  it('should throw if not service account credential', async () => {
    // The reference raises one message for every missing-credential case and
    // never inspects `auth_type` (`service_account_exchanger.py:60-67`), so a
    // wrong-typed credential reports the same missing-credentials string.
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {authType: AuthCredentialTypes.API_KEY};

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow('Service account credentials are missing');
  });

  it('should exchange with explicit keys', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-token');
  });

  it('should exchange with default credentials', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: true,
      },
    };

    const result = await exchanger.exchange({
      authCredential: credential as unknown as AuthCredential,
    });

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-adc-token');
  });

  it('should throw if explicit credentials missing', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        useDefaultCredential: false,
      },
    };

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow('Service account credentials are missing.');
  });

  it('should throw if token exchange fails (missing token)', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const mockJWT = vi.mocked(JWT);
    mockJWT.mockImplementationOnce(
      () =>
        ({
          authorize: vi.fn().mockResolvedValue({}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Failed to get access token from explicit credentials',
    );
  });

  it('should throw if token exchange throws error', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: {
          clientEmail: 'test@example.com',
          privateKey: 'key',
        },
      },
    };

    const mockJWT = vi.mocked(JWT);
    mockJWT.mockImplementationOnce(
      () =>
        ({
          authorize: vi.fn().mockRejectedValue(new Error('Auth failed')),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    await expect(
      exchanger.exchange({
        authCredential: credential as unknown as AuthCredential,
      }),
    ).rejects.toThrow(
      'Failed to exchange explicit service account token: Auth failed',
    );
  });

  it('should pass the whole service account credential to the JWT client', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {
        serviceAccountCredential: fullServiceAccountCredential(),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    };

    await exchanger.exchange({authCredential: credential});

    expect(JWT).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'agent@my-project.iam.gserviceaccount.com',
        key: '-----BEGIN PRIVATE KEY-----...',
        keyId: 'abc123',
        projectId: 'my-project',
        universeDomain: 'googleapis.com',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    );
  });

  it('should name useDefaultCredential in the missing credential message', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {scopes: []},
    };

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Service account credentials are missing. Please provide them, or set ' +
        '`useDefaultCredential: true` to use application default credentials ' +
        'in a hosted service like Cloud Run.',
    );
  });

  it('should throw if default credentials yield no token', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    stubGoogleAuthOnce(
      vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue({}),
      }),
    );

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange default service account token: Failed to get access token from default credentials',
    );
  });

  it('should throw if default credentials are unavailable', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    stubGoogleAuthOnce(vi.fn().mockRejectedValue(new Error('No ADC found')));

    await expect(
      exchanger.exchange({authCredential: credential}),
    ).rejects.toThrow(
      'Failed to exchange default service account token: No ADC found',
    );
  });

  it('should exchange a serviceAccount block whatever the authType says', async () => {
    const exchanger = new ServiceAccountCredentialExchanger();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      serviceAccount: {
        serviceAccountCredential: fullServiceAccountCredential(),
      },
    };

    const result = await exchanger.exchange({authCredential: credential});

    expect(result.wasExchanged).toBe(true);
    expect(result.credential.http?.credentials.token).toBe('mock-token');
  });
});
