/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Removes credential secrets from payloads before they reach a span
 * attribute.
 */

import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/framework_function_calls.js';
import {AuthCredentialTypes} from '../auth/auth_credential.js';

/**
 * The camelCase and snake_case names of every credential field that holds a
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

/** The `authType` values that mark an object as a credential. */
const AUTH_TYPE_VALUES: ReadonlySet<string> = new Set(
  Object.entries(AuthCredentialTypes).flatMap(([name, value]) => [
    value,
    name,
    name.toLowerCase(),
  ]),
);

const AUTH_TYPE_KEYS = ['authType', 'auth_type'] as const;
const AUTH_CONFIG_KEYS = ['authConfig', 'auth_config'] as const;
const REQUESTED_AUTH_CONFIGS_KEYS: ReadonlySet<string> = new Set([
  'requestedAuthConfigs',
  'requested_auth_configs',
]);
const CREDENTIAL_CARRIER_KEYS: ReadonlySet<string> = new Set([
  'rawAuthCredential',
  'raw_auth_credential',
  'exchangedAuthCredential',
  'exchanged_auth_credential',
]);

/** Plain objects only: a class instance such as a `Date` passes through. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Returns a copy of an auth config subtree without its secret keys. */
function redactAuthConfigSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuthConfigSecrets(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !CREDENTIAL_SECRET_KEYS.has(key))
        .map(([key, item]) => [key, redactAuthConfigSecrets(item)]),
    );
  }
  return value;
}

/**
 * Returns a copy of `value` with the secrets of every credential it carries
 * removed: credential objects, `adk_request_credential` calls, requested auth
 * configs and raw or exchanged credentials. `value` itself is not changed.
 *
 * `value` must be a JSON value, such as the result of `JSON.parse`: only plain
 * objects and arrays are walked, and a cyclic value is not detected.
 */
export function redactCredentialSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialSecrets(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  for (const key of AUTH_TYPE_KEYS) {
    const authType = value[key];
    if (typeof authType === 'string' && AUTH_TYPE_VALUES.has(authType)) {
      return redactAuthConfigSecrets(value);
    }
  }

  if (value['name'] === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === 'args' && isRecord(item)) {
          const args = {...item};
          for (const authKey of AUTH_CONFIG_KEYS) {
            if (authKey in args) {
              args[authKey] = redactAuthConfigSecrets(args[authKey]);
            }
          }
          return [key, args];
        }
        if (key === 'response') {
          return [key, redactAuthConfigSecrets(item)];
        }
        return [key, redactCredentialSecrets(item)];
      }),
    );
  }

  const carrierKeys = Object.keys(value).some((key) =>
    REQUESTED_AUTH_CONFIGS_KEYS.has(key),
  )
    ? REQUESTED_AUTH_CONFIGS_KEYS
    : Object.keys(value).some((key) => CREDENTIAL_CARRIER_KEYS.has(key))
      ? CREDENTIAL_CARRIER_KEYS
      : undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      carrierKeys?.has(key)
        ? redactAuthConfigSecrets(item)
        : redactCredentialSecrets(item),
    ]),
  );
}
