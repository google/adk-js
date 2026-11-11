/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {createSign} from 'node:crypto';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
  ServiceAccountCredential,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {AuthCredentialMissingError} from './base_auth_credential_exchanger.js';

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const MISSING_SERVICE_ACCOUNT_CREDENTIALS =
  'Service account credentials are missing. Please provide them, or set ' +
  '`useDefaultCredential: true` to use application default credentials in a ' +
  'hosted service like Cloud Run.';

/**
 * Google's OAuth2 token endpoint. It is where google-auth-library sends the
 * grant, and it is the audience of every service account assertion, whichever
 * endpoint receives it.
 */
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Lifetime of a signed assertion, in seconds. */
const ASSERTION_LIFETIME_SECONDS = 3600;

/**
 * How long to wait for a custom token endpoint to answer, in milliseconds,
 * before the exchange fails.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reports whether the key names a token endpoint other than Google's, which
 * google-auth-library cannot post to.
 */
function hasCustomTokenUri(creds: ServiceAccountCredential): boolean {
  return !!creds.tokenUri && creds.tokenUri !== GOOGLE_TOKEN_URI;
}

/** Encodes a JSON value as unpadded base64url. */
function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Signs the RS256 assertion of an OAuth2 JWT-bearer grant for a service
 * account key.
 *
 * @param creds - The service account key.
 * @param scopes - The scopes to request.
 * @param issuedAt - The issue time, in seconds since the epoch.
 * @returns The compact-serialized JWT.
 */
function signJwtBearerAssertion(
  creds: ServiceAccountCredential,
  scopes: string[],
  issuedAt: number,
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(creds.privateKeyId ? {kid: creds.privateKeyId} : {}),
  };
  const payload = {
    iss: creds.clientEmail,
    scope: scopes.join(' '),
    aud: GOOGLE_TOKEN_URI,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(creds.privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Reads the OAuth2 `error` and `error_description` fields from a failed token
 * response when the body is JSON.
 */
async function readTokenErrorDetail(
  response: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return undefined;
    }
    const parts: string[] = [];
    if (
      'error' in body &&
      typeof body.error === 'string' &&
      body.error.length > 0
    ) {
      parts.push(body.error);
    }
    if (
      'error_description' in body &&
      typeof body.error_description === 'string' &&
      body.error_description.length > 0
    ) {
      parts.push(body.error_description);
    }
    return parts.length > 0 ? parts.join(': ') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Requests an access token from the key's own `tokenUri` with an OAuth2
 * JWT-bearer grant.
 *
 * @param creds - The service account key.
 * @param scopes - The scopes to request.
 * @returns The access token, or `undefined` when the response carries none.
 * @throws Error - If the token endpoint answers with a non-2xx status, or
 *     does not answer within {@link TOKEN_REQUEST_TIMEOUT_MS}.
 */
async function requestJwtBearerToken(
  creds: ServiceAccountCredential,
  scopes: string[],
): Promise<string | undefined> {
  const assertion = signJwtBearerAssertion(
    creds,
    scopes,
    Math.floor(Date.now() / 1000),
  );
  const response = await fetch(creds.tokenUri, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await readTokenErrorDetail(response);
    throw new Error(
      detail
        ? `Token endpoint responded with HTTP ${response.status}: ${detail}`
        : `Token endpoint responded with HTTP ${response.status}`,
    );
  }

  const body: unknown = await response.json();
  if (
    typeof body === 'object' &&
    body !== null &&
    'access_token' in body &&
    typeof body.access_token === 'string'
  ) {
    return body.access_token;
  }
  return undefined;
}

/**
 * Fetches credentials for Google Service Account.
 */
@experimental
export class ServiceAccountCredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential} = params;

    // `serviceAccount` is the discriminator, not `authType`: adk-python never
    // reads the type, so a credential carrying key material is exchanged
    // whatever it announces.
    if (!authCredential.serviceAccount) {
      // One message for every missing-credential case, as the reference has
      // (`service_account_exchanger.py:60-67`): its single guard covers a null
      // credential, a null `service_account`, and both sub-fields unset, and it
      // never reads `auth_type`. Branching on the type produced a second string
      // -- "Invalid credential type for ..." -- with no counterpart there.
      throw new AuthCredentialMissingError(MISSING_SERVICE_ACCOUNT_CREDENTIALS);
    }

    const saConfig = authCredential.serviceAccount;

    if (saConfig.useDefaultCredential) {
      return this.exchangeForDefaultCredential(saConfig);
    }

    return this.exchangeForExplicitCredential(saConfig);
  }

  private async exchangeForDefaultCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    try {
      const auth = new GoogleAuth({
        scopes: saConfig.scopes || DEFAULT_SCOPES,
      });
      const client = await auth.getClient();
      const tokenResponse = await client.getAccessToken();
      const token = tokenResponse.token;

      if (!token) {
        throw new Error('Failed to get access token from default credentials');
      }

      return {
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token},
          },
        },
        wasExchanged: true,
      };
    } catch (error) {
      // The reference's catch-all raises `AuthCredentialMissingError`
      // (`service_account_exchanger.py:95`), not a distinct exchange-failure
      // type. A caller taught to catch it must not miss this path.
      throw new AuthCredentialMissingError(
        `Failed to exchange default service account token: ${(error as Error).message}`,
      );
    }
  }

  private async exchangeForExplicitCredential(
    saConfig: ServiceAccount,
  ): Promise<ExchangeResult> {
    const creds = saConfig.serviceAccountCredential;
    if (!creds) {
      // Same condition, same type as the check above: the reference raises
      // `AuthCredentialMissingError` for missing service-account material at
      // `service_account_exchanger.py:68`, and this is the explicit-credential
      // branch of it.
      throw new AuthCredentialMissingError(MISSING_SERVICE_ACCOUNT_CREDENTIALS);
    }

    try {
      let token: string | null | undefined;
      if (hasCustomTokenUri(creds)) {
        token = await requestJwtBearerToken(creds, saConfig.scopes ?? []);
      } else {
        // `authUri` and the certificate URLs have no counterpart on the JWT
        // client, which always posts to Google's token endpoint.
        const client = new JWT({
          email: creds.clientEmail,
          key: creds.privateKey,
          keyId: creds.privateKeyId,
          projectId: creds.projectId,
          universeDomain: creds.universeDomain,
          scopes: saConfig.scopes,
        });

        const tokens = await client.authorize();
        token = tokens.access_token;
      }

      if (!token) {
        throw new Error('Failed to get access token from explicit credentials');
      }

      return {
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token},
          },
        },
        wasExchanged: true,
      };
    } catch (error) {
      // As above: `service_account_exchanger.py:95` is the only catch-all in
      // the reference and it raises `AuthCredentialMissingError`.
      throw new AuthCredentialMissingError(
        `Failed to exchange explicit service account token: ${(error as Error).message}`,
      );
    }
  }
}
