/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {redactCredentialSecrets} from '../../src/telemetry/credential_redaction.js';

const SECRET = 'secret-value-1';

describe('redactCredentialSecrets', () => {
  it.each(['oauth2', 'OAUTH2', 'serviceAccount', 'service_account', 'apiKey'])(
    'removes the secrets of a credential whose authType is %s',
    (authType) => {
      const credential = {
        authType,
        apiKey: SECRET,
        oauth2: {
          clientId: 'client-1',
          clientSecret: SECRET,
          accessToken: SECRET,
          refresh_token: SECRET,
        },
        serviceAccount: {
          serviceAccountCredential: {
            privateKey: SECRET,
            private_key_id: SECRET,
          },
        },
      };

      expect(redactCredentialSecrets({result: credential})).toEqual({
        result: {
          authType,
          oauth2: {clientId: 'client-1'},
          serviceAccount: {serviceAccountCredential: {}},
        },
      });
    },
  );

  it('removes the auth config secrets of an adk_request_credential call', () => {
    const call = {
      name: 'adk_request_credential',
      args: {
        functionCallId: 'call-1',
        authConfig: {
          exchangedAuthCredential: {
            oauth2: {accessToken: SECRET, idToken: SECRET},
          },
        },
      },
      response: {http: {credentials: {token: SECRET, password: SECRET}}},
    };

    expect(redactCredentialSecrets(call)).toEqual({
      name: 'adk_request_credential',
      args: {
        functionCallId: 'call-1',
        authConfig: {exchangedAuthCredential: {oauth2: {}}},
      },
      response: {http: {credentials: {}}},
    });
  });

  it('removes the secrets of requested auth configs', () => {
    expect(
      redactCredentialSecrets({
        requestedAuthConfigs: {
          'call-1': {authCode: SECRET, codeVerifier: SECRET},
        },
        status: 'pending',
      }),
    ).toEqual({requestedAuthConfigs: {'call-1': {}}, status: 'pending'});
  });

  it('removes the secrets of raw and exchanged credentials', () => {
    expect(
      redactCredentialSecrets({
        raw_auth_credential: {http: {additionalHeaders: {key: SECRET}}},
        exchangedAuthCredential: {oauth2: {authResponseUri: SECRET}},
        label: 'kept',
      }),
    ).toEqual({
      raw_auth_credential: {http: {}},
      exchangedAuthCredential: {oauth2: {}},
      label: 'kept',
    });
  });

  it('keeps a payload that carries no credential', () => {
    const payload = {token: 'not a credential', items: [1, 'two', null]};

    expect(redactCredentialSecrets(payload)).toEqual(payload);
  });

  it('does not change its input', () => {
    const payload = {credential: {authType: 'http', http: {token: SECRET}}};
    const copy = structuredClone(payload);

    redactCredentialSecrets(payload);

    expect(payload).toEqual(copy);
  });
});
