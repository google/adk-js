/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SecretManagerServiceClient} from '@google-cloud/secret-manager';
import {SecretManagerClient} from '@google/adk';
import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {accessSecretVersion, getClient} = vi.hoisted(() => ({
  accessSecretVersion: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: vi.fn(() => ({accessSecretVersion})),
}));

vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  return {...actual, GoogleAuth: vi.fn(() => ({getClient}))};
});

const SECRET_NAME = 'projects/my-project/secrets/my-secret/versions/latest';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test',
  client_email: 'test@example.com',
  private_key: '1234',
};

describe('SecretManagerClient', () => {
  beforeEach(() => {
    accessSecretVersion.mockResolvedValue([
      {payload: {data: new TextEncoder().encode('my secret ✓')}},
    ]);
    getClient.mockResolvedValue({kind: 'default-client'});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes the parsed service account as credentials', async () => {
    const client = new SecretManagerClient({
      serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
    });

    await client.getSecret(SECRET_NAME);

    expect(SecretManagerServiceClient).toHaveBeenCalledWith({
      credentials: SERVICE_ACCOUNT,
    });
    expect(GoogleAuth).not.toHaveBeenCalled();
  });

  it('passes an OAuth2Client that carries the auth token', async () => {
    const client = new SecretManagerClient({authToken: 'my-token'});

    await client.getSecret(SECRET_NAME);

    expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
    expect(SecretManagerServiceClient).toHaveBeenCalledWith({
      authClient: expect.any(OAuth2Client),
    });
    expect(
      vi.mocked(SecretManagerServiceClient).mock.calls[0][0],
    ).toMatchObject({authClient: {credentials: {access_token: 'my-token'}}});
    expect(GoogleAuth).not.toHaveBeenCalled();
  });

  it('uses default credentials when no option is given', async () => {
    const client = new SecretManagerClient();

    await client.getSecret(SECRET_NAME);

    expect(GoogleAuth).toHaveBeenCalledWith({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    expect(SecretManagerServiceClient).toHaveBeenCalledWith({
      authClient: {kind: 'default-client'},
    });
  });

  it('explains the missing options when default credentials fail', async () => {
    const cause = new Error('Could not load the default credentials.');
    getClient.mockRejectedValue(cause);
    const client = new SecretManagerClient();

    const result = client.getSecret(SECRET_NAME);

    await expect(result).rejects.toThrow(
      "'serviceAccountJson' or 'authToken' are both missing, and error " +
        'occurred while trying to use default credentials: ' +
        'Could not load the default credentials.',
    );
    await expect(result).rejects.toMatchObject({cause});
    expect(SecretManagerServiceClient).not.toHaveBeenCalled();
  });

  it('throws from the constructor on invalid service account JSON', () => {
    expect(
      () => new SecretManagerClient({serviceAccountJson: '{not json'}),
    ).toThrow('Invalid service account JSON:');
  });

  it('requests the named version and decodes a byte payload as UTF-8', async () => {
    const client = new SecretManagerClient({authToken: 'my-token'});

    expect(await client.getSecret(SECRET_NAME)).toBe('my secret ✓');
    expect(accessSecretVersion).toHaveBeenCalledWith({name: SECRET_NAME});
  });

  it('returns a string payload unchanged', async () => {
    accessSecretVersion.mockResolvedValue([{payload: {data: 'plain text'}}]);
    const client = new SecretManagerClient({authToken: 'my-token'});

    expect(await client.getSecret(SECRET_NAME)).toBe('plain text');
  });

  it('propagates an error from Secret Manager', async () => {
    const apiError = new Error('5 NOT_FOUND: Secret not found');
    accessSecretVersion.mockRejectedValue(apiError);
    const client = new SecretManagerClient({authToken: 'my-token'});

    await expect(client.getSecret(SECRET_NAME)).rejects.toBe(apiError);
  });

  it('creates the Secret Manager client once across calls', async () => {
    const client = new SecretManagerClient({authToken: 'my-token'});

    await client.getSecret(SECRET_NAME);
    await client.getSecret(SECRET_NAME);

    expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
    expect(accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('does not create the Secret Manager client before the first call', () => {
    new SecretManagerClient({authToken: 'my-token'});

    expect(SecretManagerServiceClient).not.toHaveBeenCalled();
  });

  it('tries default credentials again after they fail once', async () => {
    getClient
      .mockRejectedValueOnce(new Error('Metadata server not ready.'))
      .mockResolvedValueOnce({kind: 'default-client'});
    const client = new SecretManagerClient();

    await expect(client.getSecret(SECRET_NAME)).rejects.toThrow(
      'Metadata server not ready.',
    );
    expect(await client.getSecret(SECRET_NAME)).toBe('my secret ✓');
    expect(getClient).toHaveBeenCalledTimes(2);
    expect(SecretManagerServiceClient).toHaveBeenCalledTimes(1);
  });
});
