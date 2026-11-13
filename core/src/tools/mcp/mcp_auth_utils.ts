/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {omit} from 'lodash-es';

import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {stableHash} from '../../utils/hash_utils.js';

/**
 * The authentication fields that {@link MCPToolOptions} and
 * {@link MCPToolsetOptions} accept.
 */
interface MCPAuthFields {
  authConfig?: AuthConfig;
  authScheme?: AuthScheme;
  authCredential?: AuthCredential;
  credentialKey?: string;
}

/**
 * OAuth2 fields that change during one authorization flow, or from one token
 * to the next. They are left out of the default credential key, so the key
 * stays the same before and after the user signs in.
 */
const TRANSIENT_OAUTH2_FIELDS = [
  'authUri',
  'state',
  'authResponseUri',
  'authCode',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'expiresIn',
  'redirectUri',
] as const;

/**
 * Builds a credential key from the scheme and the stable fields of the
 * credential, so tools configured with the same scheme and credential share
 * one entry in the credential service.
 */
function buildDefaultCredentialKey(
  authScheme: AuthScheme,
  authCredential: AuthCredential | undefined,
): string {
  const schemeName = `${authScheme.type}_${stableHash(authScheme)}`;
  if (!authCredential) {
    return `adk_${schemeName}_`;
  }
  const stableCredential = authCredential.oauth2
    ? {
        ...authCredential,
        oauth2: omit(authCredential.oauth2, TRANSIENT_OAUTH2_FIELDS),
      }
    : authCredential;
  return `adk_${schemeName}_${authCredential.authType}_${stableHash(stableCredential)}`;
}

/**
 * Returns the {@link AuthConfig} that `fields` describe, or `undefined` when
 * they configure no authentication.
 *
 * A caller gives either `authConfig`, or `authScheme` with an optional
 * `authCredential` and `credentialKey`. Without a `credentialKey`, a stable
 * key is derived from the scheme and the credential.
 *
 * @param fields The authentication fields of the constructor options.
 * @param owner The class name used in error messages.
 * @throws If `authConfig` is given together with the other fields, or if
 *     `authCredential` or `credentialKey` is given without `authScheme`.
 */
export function resolveAuthConfig(
  fields: MCPAuthFields,
  owner: string,
): AuthConfig | undefined {
  const {authConfig, authScheme, authCredential, credentialKey} = fields;
  const hasSchemeFields =
    authScheme !== undefined ||
    authCredential !== undefined ||
    credentialKey !== undefined;

  if (authConfig) {
    if (hasSchemeFields) {
      throw new Error(
        `${owner} takes either authConfig or authScheme, authCredential and credentialKey, not both.`,
      );
    }
    return authConfig;
  }
  if (!authScheme) {
    if (hasSchemeFields) {
      throw new Error(
        `${owner} needs an authScheme when authCredential or credentialKey is set.`,
      );
    }
    return undefined;
  }
  return {
    authScheme,
    rawAuthCredential: authCredential,
    credentialKey:
      credentialKey ?? buildDefaultCredentialKey(authScheme, authCredential),
  };
}

/**
 * Merges header records into one, comparing names case-insensitively.
 *
 * When two records set the same header in any casing, the later value and
 * its name win, so the result never holds two spellings of one header.
 *
 * @param records The header records, from lowest to highest precedence.
 * @return The merged headers.
 */
export function mergeHeaders(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> {
  const byLowerName = new Map<string, [string, string]>();
  for (const record of records) {
    for (const [name, value] of Object.entries(record ?? {})) {
      byLowerName.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(byLowerName.values());
}
