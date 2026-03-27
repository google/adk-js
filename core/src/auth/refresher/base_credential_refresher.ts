/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth_credential.js';
import {AuthScheme} from '../auth_schemes.js';

/**
 * Base exception for credential refresh errors.
 */
export class CredentialRefresherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialRefresherError';
  }
}

/**
 * Base interface for credential refreshers.
 *
 * Credential refreshers are responsible for checking if a credential is expired
 * or needs to be refreshed, and for refreshing it if necessary.
 */
export interface BaseCredentialRefresher {
  /**
   * Checks if a credential needs to be refreshed.
   *
   * @param authCredential The credential to check.
   * @param authScheme The authentication scheme (optional).
   * @returns True if the credential needs to be refreshed, False otherwise.
   */
  isRefreshNeeded(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<boolean>;

  /**
   * Refreshes a credential if needed.
   *
   * @param authCredential The credential to refresh.
   * @param authScheme The authentication scheme (optional).
   * @returns The refreshed credential.
   * @throws {CredentialRefresherError} If credential refresh fails.
   */
  refresh(
    authCredential: AuthCredential,
    authScheme?: AuthScheme,
  ): Promise<AuthCredential>;
}
