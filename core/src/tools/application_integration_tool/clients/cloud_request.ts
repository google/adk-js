/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, JWTInput} from 'google-auth-library';
import {getErrorMessage} from '../../../utils/error_utils.js';

/** OAuth scope every Integration Connectors and Application Integration call needs. */
export const CLOUD_PLATFORM_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

const MISSING_CREDENTIALS_MESSAGE =
  'Please provide a service account that has the required permissions to access the connection.';

/** Wraps a failure as `An unexpected error occurred: …`. */
export function unexpectedError(e: unknown): Error {
  return new Error(`An unexpected error occurred: ${getErrorMessage(e)}`, {
    cause: e,
  });
}

/**
 * Supplies cloud-platform access tokens from a service-account key, or from
 * Application Default Credentials when no key is given.
 *
 * One instance holds one `GoogleAuth`, which caches the token and refreshes it
 * before it expires.
 */
export class CloudPlatformTokenSource {
  private auth?: GoogleAuth;

  constructor(private readonly serviceAccountJson?: string) {}

  /**
   * Returns an access token.
   *
   * @throws Error When no key is given and Application Default Credentials are
   *   unavailable, or when no token is issued.
   */
  async getAccessToken(): Promise<string> {
    let token: string | null | undefined;
    try {
      token = await this.getAuth().getAccessToken();
    } catch (e: unknown) {
      if (this.serviceAccountJson) {
        throw e;
      }
      throw new Error(MISSING_CREDENTIALS_MESSAGE, {cause: e});
    }
    if (!token) {
      throw new Error(MISSING_CREDENTIALS_MESSAGE);
    }
    return token;
  }

  private getAuth(): GoogleAuth {
    if (!this.auth) {
      if (this.serviceAccountJson) {
        const credentials: JWTInput = JSON.parse(this.serviceAccountJson);
        this.auth = new GoogleAuth({
          scopes: [CLOUD_PLATFORM_SCOPE],
          credentials,
        });
      } else {
        this.auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});
      }
    }
    return this.auth;
  }
}

/** Options for {@link sendCloudRequest}. */
export interface SendCloudRequestOptions {
  /** The request URL. */
  url: string;
  /** The HTTP method. */
  method: 'GET' | 'POST';
  /** The JSON request body for a POST request. */
  body?: unknown;
  /** Supplies the bearer token. */
  tokenSource: CloudPlatformTokenSource;
  /** The message for an HTTP 400 or 404 response. */
  invalidRequestMessage: string;
}

/**
 * Sends an authenticated JSON request to a Google Cloud API and returns the
 * parsed response body.
 *
 * @param options The request URL, method, body, token source, and 400/404 message.
 * @throws Error `invalidRequestMessage` for HTTP 400 and 404,
 *   `Request error: …` for any other non-2xx status or a failed fetch, and
 *   `An unexpected error occurred: …` for anything else, such as a missing
 *   credential or a body that is not JSON.
 */
export async function sendCloudRequest(
  options: SendCloudRequestOptions,
): Promise<unknown> {
  const {url, method, body, tokenSource, invalidRequestMessage} = options;
  let token: string;
  try {
    token = await tokenSource.getAccessToken();
  } catch (e: unknown) {
    throw unexpectedError(e);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: unknown) {
    throw new Error(`Request error: ${getErrorMessage(e)}`, {cause: e});
  }

  if (response.status === 400 || response.status === 404) {
    throw new Error(invalidRequestMessage);
  }
  if (!response.ok) {
    throw new Error(
      `Request error: HTTP ${response.status} ${response.statusText} for url: ${url}`,
    );
  }

  try {
    return await response.json();
  } catch (e: unknown) {
    throw unexpectedError(e);
  }
}
