/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../../../agents/framework_function_calls.js';
import {AuthCredentialTypes} from '../../../../auth/auth_credential.js';

/**
 * camelCase and snake_case names of every credential field that holds a
 * secret.
 */
const CREDENTIAL_SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'token',
  'additionalHeaders',
  'additional_headers',
  'clientSecret',
  'client_secret',
  'authResponseUri',
  'auth_response_uri',
  'authCode',
  'auth_code',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'codeVerifier',
  'code_verifier',
  'privateKeyId',
  'private_key_id',
  'privateKey',
  'private_key',
  'apiKey',
  'api_key',
]);

/** Keys whose value is a whole credential or auth config. */
const CREDENTIAL_CARRIER_KEYS: ReadonlySet<string> = new Set([
  'requestedAuthConfigs',
  'requested_auth_configs',
  'rawAuthCredential',
  'raw_auth_credential',
  'exchangedAuthCredential',
  'exchanged_auth_credential',
]);

const AUTH_TYPE_VALUES: ReadonlySet<string> = new Set(
  Object.entries(AuthCredentialTypes).flatMap(([name, value]) => [
    value,
    name,
    name.toLowerCase(),
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactAuthConfigSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuthConfigSecrets);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CREDENTIAL_SECRET_KEYS.has(key))
      .map(([key, item]) => [key, redactAuthConfigSecrets(item)]),
  );
}

function isAuthCredential(value: Record<string, unknown>): boolean {
  return ['authType', 'auth_type'].some((key) => {
    const authType = value[key];
    return typeof authType === 'string' && AUTH_TYPE_VALUES.has(authType);
  });
}

function redactCredentialRequest(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === 'args' && isRecord(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([argKey, arg]) => [
              argKey,
              argKey === 'authConfig' || argKey === 'auth_config'
                ? redactAuthConfigSecrets(arg)
                : arg,
            ]),
          ),
        ];
      }
      if (key === 'response') {
        return [key, redactAuthConfigSecrets(item)];
      }
      return [key, redactCredentialSecrets(item)];
    }),
  );
}

/**
 * Returns a copy of a JSON-like payload with credential secrets removed.
 *
 * Removes the secret fields of anything shaped like an auth credential or auth
 * config, wherever it is nested: a credential object, the arguments and
 * response of a credential request, and the credential-carrying fields of
 * event actions.
 */
export function redactCredentialSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCredentialSecrets);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (isAuthCredential(value)) {
    return redactAuthConfigSecrets(value);
  }
  if (value['name'] === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return redactCredentialRequest(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      CREDENTIAL_CARRIER_KEYS.has(key)
        ? redactAuthConfigSecrets(item)
        : redactCredentialSecrets(item),
    ]),
  );
}
