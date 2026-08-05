/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {AuthCredential} from '../auth_credential.js';
import {AuthConfig} from '../auth_tool.js';

import {BaseCredentialService} from './base_credential_service.js';

/**
 * @experimental  (Experimental, subject to change) Class for in memory
 * implementation of credential service
 */
export class InMemoryCredentialService implements BaseCredentialService {
  /**
   * A map from app name to a map from user ID to a map from credential key to
   * credential.
   *
   * `appName`, `userId` and `credentialKey` are all attacker-influenced, so
   * every level is created with `Object.create(null)`. On an ordinary `{}`
   * literal a key of `__proto__` resolves to the inherited `__proto__`
   * accessor rather than creating an own property, so nested assignment
   * pollutes every object in the process, and a lookup of an inherited key
   * such as `toString` returns a function instead of `undefined`.
   */
  private readonly credentials: Record<
    string,
    Record<string, Record<string, AuthCredential>>
  > = Object.create(null);

  loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialBucket = this.getBucketForCurrentContext(toolContext);

    return Promise.resolve(credentialBucket[authConfig.credentialKey]);
  }

  async saveCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<void> {
    const credentialBucket = this.getBucketForCurrentContext(toolContext);

    if (authConfig.exchangedAuthCredential) {
      credentialBucket[authConfig.credentialKey] =
        authConfig.exchangedAuthCredential;
    }
  }

  private getBucketForCurrentContext(
    toolContext: Context,
  ): Record<string, AuthCredential> {
    const {appName, userId} = toolContext.invocationContext.session;

    if (!this.credentials[appName]) {
      this.credentials[appName] = Object.create(null);
    }

    if (!this.credentials[appName][userId]) {
      this.credentials[appName][userId] = Object.create(null);
    }

    return this.credentials[appName][userId];
  }
}
