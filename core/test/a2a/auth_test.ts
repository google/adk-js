/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Request} from 'express';
import {IncomingHttpHeaders} from 'node:http';
import {describe, expect, it} from 'vitest';
import {bearerTokenUserBuilder} from '../../src/a2a/auth.js';

const TOKEN = 's3cr3t';

/**
 * Builds the minimal Express request the authenticator reads: it only ever
 * touches `headers`.
 */
function requestWithHeaders(headers: IncomingHttpHeaders): Request {
  return {headers} as unknown as Request;
}

describe('bearerTokenUserBuilder', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('throws when the token is %s', (_label, token) => {
    expect(() => bearerTokenUserBuilder(token)).toThrow(
      /empty A2A bearer token is not a valid authenticator/,
    );
  });

  it.each([
    ['the configured token', TOKEN, `Bearer ${TOKEN}`],
    ['a case-insensitive bearer scheme', TOKEN, `bearer ${TOKEN}`],
    // HTTP strips whitespace around header values, so a padded token would
    // otherwise be impossible for any caller to present.
    ['a token configured with padding', `  ${TOKEN}  `, `Bearer ${TOKEN}`],
  ])('authenticates %s', async (_label, configuredToken, authorization) => {
    const userBuilder = bearerTokenUserBuilder(configuredToken);

    const user = await userBuilder(requestWithHeaders({authorization}));

    expect(user).toEqual({
      isAuthenticated: true,
      userName: 'a2a-bearer-token',
    });
  });

  it.each([
    ['no Authorization header', undefined],
    ['a non-bearer scheme', 'Basic czNjcjN0'],
    // Same length as TOKEN, so this exercises the comparison itself rather
    // than the length guard in front of it.
    ['a wrong token of the same length', 'Bearer S3CR3T'],
    ['a wrong token of a different length', `Bearer ${TOKEN}-and-more`],
  ])('rejects %s', async (_label, authorization) => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    await expect(
      userBuilder(requestWithHeaders({authorization})),
    ).rejects.toThrow(/missing or invalid/);
  });
});
