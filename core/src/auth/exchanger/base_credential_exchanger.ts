/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth_credential.js';
import {AuthScheme} from '../auth_schemes.js';

/**
 * Base exception for credential exchange errors.
 */
export class CredentialExchangeError extends Error {}

/**
 * Base interface for credential exchangers.
 *
 * Credential exchangers are responsible for exchanging credentials from
 * one format or scheme to another.
 */
export interface BaseCredentialExchanger {
  /**
   * Exchange credential if needed.
   *
   * @param authCredential - The credential to exchange.
   * @param authScheme - The authentication scheme (optional, some exchangers don't need it).
   * @returns The exchanged credential.
   * @throws CredentialExchangeError: If credential exchange fails.
   */

  exchange({
    authCredential,
    authScheme,
  }: {
    authCredential: AuthCredential;
    authScheme?: AuthScheme;
  }): Promise<AuthCredential>;
}
