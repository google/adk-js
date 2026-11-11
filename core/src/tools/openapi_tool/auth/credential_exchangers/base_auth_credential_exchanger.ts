/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {experimental} from '../../../../utils/experimental.js';

/**
 * Error raised when a required authentication credential is missing.
 */
export class AuthCredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialMissingError';
  }
}

/**
 * Base class for authentication credential exchangers.
 *
 * A subclass exchanges the credential an OpenAPI tool was configured with for
 * one that can be sent to the API. The base implementation always throws, so a
 * subclass that forgets to override the method fails on the first call rather
 * than silently returning nothing.
 */
@experimental
export class BaseAuthCredentialExchanger {
  /**
   * Exchanges the provided authentication credential for a usable
   * token or credential.
   *
   * @param _authScheme The security scheme.
   * @param _authCredential The authentication credential.
   * @returns An updated AuthCredential object containing the fetched
   *     credential. For simple schemes like API key, it may return the original
   *     credential if no exchange is needed.
   * @throws {Error} If the method is not implemented by a subclass.
   */
  @experimental
  exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): AuthCredential {
    throw new Error('Subclasses must implement exchangeCredential.');
  }
}
