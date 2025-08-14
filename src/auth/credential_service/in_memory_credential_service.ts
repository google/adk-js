/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolContext} from '../../tools/tool_context.js';
import {AuthCredential} from '../auth_credential.js';
import {AuthConfig} from '../auth_tool.js';

import {BaseCredentialService} from './base_credential_service.js';

/**
 * @experimental  (Experimental, subject to change) Class for in memory
 * implementation of credential service
 */
export class InMemoryCredentialService implements BaseCredentialService {
  private readonly credentials:
      Record<string, Record<string, Record<string, AuthCredential>>> = {};

  loadCredential(
      authConfig: AuthConfig,
      toolContext: ToolContext,
      ): Promise<AuthCredential|undefined> {
    const credentialBucket = this.getBucketForCurrentContext(toolContext);

    return Promise.resolve(credentialBucket[authConfig.credentialKey]);
  }

  async saveCredential(
      authConfig: AuthConfig,
      toolContext: ToolContext,
      ): Promise<void> {
    const credentialBucket = this.getBucketForCurrentContext(toolContext);

    if (authConfig.exchangedAuthCredential) {
      credentialBucket[authConfig.credentialKey] =
          authConfig.exchangedAuthCredential;
    }
  }

  private getBucketForCurrentContext(toolContext: ToolContext):
      Record<string, AuthCredential> {
    const {appName, userId} = toolContext.invocationContext.session;

    if (!this.credentials[appName]) {
      this.credentials[appName] = {};
    }

    if (!this.credentials[appName][userId]) {
      this.credentials[appName][userId] = {};
    }

    return this.credentials[appName][userId];
  }
}
