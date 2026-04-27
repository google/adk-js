/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes} from '../auth_credential.js';
import {BaseCredentialRefresher} from './base_credential_refresher.js';

/**
 * Registry for credential refresher instances.
 */
export class CredentialRefresherRegistry {
  private readonly refreshers: Record<
    AuthCredentialTypes,
    BaseCredentialRefresher | undefined
  > = {
    [AuthCredentialTypes.API_KEY]: undefined,
    [AuthCredentialTypes.HTTP]: undefined,
    [AuthCredentialTypes.OAUTH2]: undefined,
    [AuthCredentialTypes.OPEN_ID_CONNECT]: undefined,
    [AuthCredentialTypes.SERVICE_ACCOUNT]: undefined,
  };

  /**
   * Register a refresher instance for a credential type.
   *
   * @param credentialType The credential type to register for.
   * @param refresherInstance The refresher instance to register.
   */
  register(
    credentialType: AuthCredentialTypes,
    refresherInstance: BaseCredentialRefresher,
  ): void {
    this.refreshers[credentialType] = refresherInstance;
  }

  /**
   * Get the refresher instance for a credential type.
   *
   * @param credentialType The credential type to get refresher for.
   * @returns The refresher instance if registered, undefined otherwise.
   */
  getRefresher(
    credentialType: AuthCredentialTypes,
  ): BaseCredentialRefresher | undefined {
    return this.refreshers[credentialType];
  }
}
