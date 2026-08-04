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
 * Creates a map with no prototype, for data keyed by untrusted input.
 *
 * `appName`, `userId` and `credentialKey` are all attacker-influenced. With an
 * ordinary `{}` literal a key of `__proto__` resolves to `Object.prototype`
 * rather than creating an own property, so nested assignment would pollute
 * every object in the process; and a lookup of an inherited key such as
 * `toString` would return a function instead of `undefined`.
 */
function createNullProtoMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * @experimental  (Experimental, subject to change) Class for in memory
 * implementation of credential service
 */
export class InMemoryCredentialService implements BaseCredentialService {
  private readonly credentials: Record<
    string,
    Record<string, Record<string, AuthCredential>>
  > = createNullProtoMap();

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
      this.credentials[appName] = createNullProtoMap();
    }

    if (!this.credentials[appName][userId]) {
      this.credentials[appName][userId] = createNullProtoMap();
    }

    return this.credentials[appName][userId];
  }
}
