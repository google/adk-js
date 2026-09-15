/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import * as devPackage from '../src/index.js';
import {
  ENFORCE_USER_IDENTITY_ENV_VAR,
  IAP_AUTHENTICATED_USER_EMAIL_HEADER,
  IAP_JWT_ASSERTION_HEADER,
  iapUserIdResolver,
} from '../src/server/adk_api_server.js';

describe('package surface', () => {
  // The identity enforcement hook is only usable by an embedder if it reaches
  // the package entry point. Exporting it from the module alone leaves
  // `resolveUserId` reachable only through a deep import of an internal path.
  it('exposes the caller identity extension point', () => {
    expect(devPackage.iapUserIdResolver).toBe(iapUserIdResolver);
    expect(devPackage.ENFORCE_USER_IDENTITY_ENV_VAR).toBe(
      ENFORCE_USER_IDENTITY_ENV_VAR,
    );
    expect(devPackage.IAP_AUTHENTICATED_USER_EMAIL_HEADER).toBe(
      IAP_AUTHENTICATED_USER_EMAIL_HEADER,
    );
    expect(devPackage.IAP_JWT_ASSERTION_HEADER).toBe(IAP_JWT_ASSERTION_HEADER);
  });

  it('exposes the server and client it has always exported', () => {
    expect(devPackage.AdkApiServer).toBeTypeOf('function');
    expect(devPackage.AdkApiClient).toBeTypeOf('function');
  });
});
