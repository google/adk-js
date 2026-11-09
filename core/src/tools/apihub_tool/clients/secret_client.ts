/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {SecretManagerServiceClient} from '@google-cloud/secret-manager';
import {AuthClient, GoogleAuth, OAuth2Client} from 'google-auth-library';
import {loadOptionalPeer} from '../../../utils/optional_peer.js';
import {parseServiceAccountJson} from './service_account.js';

/** OAuth scope requested when falling back to default credentials. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Options for {@link SecretManagerClient}. */
export interface SecretManagerClientOptions {
  /**
   * The content of a service account key file, as a JSON string, not a path.
   * Takes precedence over `authToken`.
   */
  serviceAccountJson?: string;
  /** An existing OAuth access token. */
  authToken?: string;
}

/**
 * Reads secrets from Google Cloud Secret Manager.
 *
 * The client authenticates with `serviceAccountJson` when it is set, then with
 * `authToken`, and otherwise with application default credentials.
 *
 * `@google-cloud/secret-manager` is an optional peer dependency. It is loaded
 * on the first call to {@link SecretManagerClient.getSecret}, so constructing
 * the client does not require it.
 */
export class SecretManagerClient {
  private readonly credentials?: Record<string, string>;
  private readonly authToken?: string;
  private clientPromise?: Promise<SecretManagerServiceClient>;

  /**
   * @throws `Invalid service account JSON: ...` when `serviceAccountJson`
   *     does not parse.
   */
  constructor(options: SecretManagerClientOptions = {}) {
    if (options.serviceAccountJson) {
      this.credentials = parseServiceAccountJson(options.serviceAccountJson);
    } else if (options.authToken) {
      this.authToken = options.authToken;
    }
  }

  /**
   * Returns the payload of a secret version as a UTF-8 string.
   *
   * @param resourceName The secret version, in the form
   *     `projects/{project}/secrets/{secret}/versions/{version}`. Use
   *     `latest` as the version to read the newest one.
   * @throws When default credentials are needed and cannot be resolved, or
   *     when Secret Manager returns an error, such as a missing secret or a
   *     denied permission.
   */
  async getSecret(resourceName: string): Promise<string> {
    const client = await this.getClient();
    const [response] = await client.accessSecretVersion({name: resourceName});
    const data = response.payload?.data;
    if (data === undefined || data === null) {
      return '';
    }
    if (typeof data === 'string') {
      return data;
    }
    return new TextDecoder('utf-8').decode(data);
  }

  /**
   * Resolves the Secret Manager client, loading the optional peer and the
   * credentials on first use.
   *
   * A created client is kept. A failure is not kept, so the next call tries
   * again, for example once default credentials become available.
   */
  private getClient(): Promise<SecretManagerServiceClient> {
    if (!this.clientPromise) {
      const promise = this.createClient();
      this.clientPromise = promise;
      promise.catch(() => {
        if (this.clientPromise === promise) {
          this.clientPromise = undefined;
        }
      });
    }
    return this.clientPromise;
  }

  private async createClient(): Promise<SecretManagerServiceClient> {
    const {SecretManagerServiceClient} = await loadOptionalPeer(
      {
        packageName: '@google-cloud/secret-manager',
        feature: 'SecretManagerClient',
      },
      () => import('@google-cloud/secret-manager'),
    );

    if (this.credentials) {
      return new SecretManagerServiceClient({credentials: this.credentials});
    }

    if (this.authToken) {
      const authClient = new OAuth2Client();
      authClient.setCredentials({access_token: this.authToken});
      return new SecretManagerServiceClient({
        authClient: toSdkAuthClient(authClient),
      });
    }

    let authClient: AuthClient;
    try {
      authClient = await new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
      }).getClient();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(
        `'serviceAccountJson' or 'authToken' are both missing, and error ` +
          `occurred while trying to use default credentials: ${message}`,
        {cause: e},
      );
    }
    return new SecretManagerServiceClient({
      authClient: toSdkAuthClient(authClient),
    });
  }
}

/** The auth client type the Secret Manager SDK constructor accepts. */
type SdkAuthClient = NonNullable<
  NonNullable<
    ConstructorParameters<typeof SecretManagerServiceClient>[0]
  >['authClient']
>;

/**
 * Hands an auth client from this package's `google-auth-library` to the
 * Secret Manager SDK.
 *
 * The SDK depends on `google-gax`, which brings its own major version of
 * `google-auth-library`. Both `AuthClient` classes expose the same request
 * methods the SDK calls, but TypeScript treats them as unrelated because each
 * declares private members.
 */
function toSdkAuthClient(authClient: AuthClient): SdkAuthClient {
  return authClient as unknown as SdkAuthClient;
}
