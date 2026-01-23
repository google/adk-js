/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential exchanger registry.
 */
import {AuthCredentialTypes} from '../auth_credential.js';
import {BaseCredentialExchanger} from './base_credential_exchanger.js';

/**
 * Registry for credential exchanger instances.
 */
export class CredentialExchangerRegistry {
  private exchangers: Partial<
    Record<AuthCredentialTypes, BaseCredentialExchanger>
  > = {};

  /**
   * Register an exchanger instance for a credential type.
   * @param credentialType - The credential type to register for.
   * @param exchangerInstance - The exchanger instance to register.
   */
  register(
    credentialType: AuthCredentialTypes,
    exchangerInstance: BaseCredentialExchanger,
  ): void {
    this.exchangers[credentialType] = exchangerInstance;
  }

  /**
   * Get the exchanger instance for a credential type.
   * @param credentialType - The credential type to get exchanger for.
   * @returns The exchanger instance if registered, undefined otherwise.
   */
  getExchanger(
    credentialType: AuthCredentialTypes,
  ): BaseCredentialExchanger | undefined {
    return this.exchangers[credentialType];
  }
}
