/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {AuthCredential} from '../auth_credential.js';
import {AuthConfig} from '../auth_tool.js';
import {BaseCredentialService} from './base_credential_service.js';

/**
 * Class for implementation of credential service using session state as the store.
 * Note: store credential in session may not be secure, use at your own risk.
 */
export class SessionStateCredentialService implements BaseCredentialService {
  loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    return Promise.resolve(toolContext.state.get(authConfig.credentialKey));
  }

  async saveCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<void> {
    if (authConfig.exchangedAuthCredential) {
      toolContext.state.set(
        authConfig.credentialKey,
        authConfig.exchangedAuthCredential,
      );
    }
  }
}
