/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthScheme} from './auth_schemes.js';
import {BaseAuthProvider} from './base_auth_provider.js';

/**
 * Registry for auth provider instances.
 */
export class AuthProviderRegistry {
  private readonly providers = new Map<string, BaseAuthProvider>();

  /**
   * Register a provider instance for an auth scheme type.
   *
   * @param authSchemeType The auth scheme type (e.g., 'oauth2', 'apiKey').
   * @param providerInstance The provider instance to register.
   */
  register(authSchemeType: string, providerInstance: BaseAuthProvider): void {
    this.providers.set(authSchemeType, providerInstance);
  }

  /**
   * Get the provider instance for an auth scheme.
   *
   * @param authScheme The auth scheme to get provider for.
   * @returns The provider instance if registered, undefined otherwise.
   */
  getProvider(authScheme: AuthScheme): BaseAuthProvider | undefined {
    return this.providers.get(authScheme.type);
  }
}
