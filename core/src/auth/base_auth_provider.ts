/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';

/**
 * Abstract base interface for custom authentication providers.
 */
export interface BaseAuthProvider {
  /**
   * Provide an AuthCredential asynchronously.
   *
   * @param authConfig The current authentication configuration.
   * @param context The current callback context (placeholder).
   * @returns The retrieved AuthCredential, or undefined if unavailable.
   */
  getAuthCredential(
    authConfig: AuthConfig,
    context?: unknown,
  ): Promise<AuthCredential | undefined>;
}
