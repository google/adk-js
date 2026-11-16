/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../../agents/context.js';
import {logger} from '../../utils/logger.js';
import {AuthCredential, isAuthCredential} from '../auth_credential.js';
import {AuthConfig} from '../auth_tool.js';
import {BaseCredentialService} from './base_credential_service.js';

/**
 * Returns a copy of `credential` with the OAuth2 client secret removed.
 *
 * The client secret identifies the agent's OAuth2 client, not the end user, so
 * it must not reach session state, which is returned by session-read endpoints.
 * Call sites that need it for a token request restore it from the tool's own
 * configuration.
 */
function credentialWithoutClientSecret(
  credential: AuthCredential,
): AuthCredential {
  const redacted = cloneDeep(credential);
  if (redacted.oauth2) {
    delete redacted.oauth2.clientSecret;
  }
  return redacted;
}

/**
 * Returns a copy of `credential` with the configured OAuth2 client secret
 * restored from `rawCredential`.
 */
function withConfiguredClientSecret(
  credential: AuthCredential,
  rawCredential?: AuthCredential,
): AuthCredential {
  const restored = cloneDeep(credential);
  if (restored.oauth2 && rawCredential?.oauth2) {
    if (rawCredential.oauth2.clientSecret !== undefined) {
      restored.oauth2.clientSecret = rawCredential.oauth2.clientSecret;
    } else {
      delete restored.oauth2.clientSecret;
    }
  }
  return restored;
}

/**
 * Class for implementation of credential service using session state as the store.
 *
 * Warning: Storing credentials in session state is insecure. Session state may be
 * persisted in plaintext, logged, or accessible via XSS depending on the runner
 * environment, and is returned by session-read endpoints. The agent's OAuth2
 * client secret is stripped before storage and restored from the auth config on
 * load; the end user's own access and refresh tokens are kept in clear text.
 * Use a secure vault or encrypted storage for production applications.
 */
export class SessionStateCredentialService implements BaseCredentialService {
  loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    const stored = toolContext.state.get<unknown>(authConfig.credentialKey);
    if (stored === undefined || stored === null) {
      return Promise.resolve(undefined);
    }
    if (!isAuthCredential(stored)) {
      logger.warn(
        `Ignoring ${typeof stored} stored under the credential key: this store only reads credentials written by saveCredential.`,
      );
      return Promise.resolve(undefined);
    }

    return Promise.resolve(
      withConfiguredClientSecret(stored, authConfig.rawAuthCredential),
    );
  }

  async saveCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<void> {
    if (authConfig.exchangedAuthCredential) {
      toolContext.state.set(
        authConfig.credentialKey,
        credentialWithoutClientSecret(authConfig.exchangedAuthCredential),
      );
    }
  }
}
