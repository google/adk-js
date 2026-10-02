/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {AdkApiClient} from './server/adk_api_client.js';
export {
  AdkApiServer,
  ENFORCE_USER_IDENTITY_ENV_VAR,
  IAP_AUTHENTICATED_USER_EMAIL_HEADER,
  IAP_JWT_ASSERTION_HEADER,
  iapUserIdResolver,
} from './server/adk_api_server.js';
export type {UserIdResolver} from './server/adk_api_server.js';
