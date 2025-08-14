/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolContext} from '../../tools/tool_context.js';
import {AuthCredential} from '../auth_credential.js';
import {AuthConfig} from '../auth_tool.js';

/**
 * Abstract class for Service that loads / saves tool credentials from / to the
 * backend credential store.
 */
export interface BaseCredentialService {
  /**
   * Loads the credential by auth config and current tool context from the
   *  backend credential store.
   *
   * @param authConfig The auth config which contains the auth scheme and auth
   *     credential information. auth_config.get_credential_key will be used to
   *     build the key to load the credential.
   * @param toolContext The context of the current invocation when the tool is
   *     trying to load the credential.
   * @return A promise that resolves to the credential saved in the store.
   */
  loadCredential(
      authConfig: AuthConfig,
      toolContext: ToolContext,
      ): Promise<AuthCredential|undefined>;

  /*
   * Saves the exchanged_auth_credential in auth config to the backend
   * credential store.
   *
   * @param authConfig The auth config which contains the auth scheme and auth
   *     credential information. auth_config.get_credential_key will be used to
   *     build the key to save the credential.
   * @param toolContext The context of the current invocation when the tool is
   *     trying to save the credential.
   * @return A promise that resolves when the credential is saved to the store.
   */
  saveCredential(
      authConfig: AuthConfig,
      toolContext: ToolContext,
      ): Promise<void>;
}