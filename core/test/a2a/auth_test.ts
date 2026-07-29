/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Request} from 'express';
import {IncomingHttpHeaders} from 'node:http';
import {describe, expect, it, vi} from 'vitest';
import {bearerTokenUserBuilder} from '../../src/a2a/auth.js';
import {logger} from '../../src/utils/logger.js';

const TOKEN = 's3cr3t';

/**
 * Builds the minimal Express request the authenticator reads: it only ever
 * touches `headers`.
 */
function requestWithHeaders(headers: IncomingHttpHeaders): Request {
  return {headers} as unknown as Request;
}

describe('bearerTokenUserBuilder', () => {
  it('throws when the token is empty', () => {
    expect(() => bearerTokenUserBuilder('')).toThrow(
      /empty A2A bearer token is not a valid authenticator/,
    );
  });

  it('throws when the token is whitespace only', () => {
    expect(() => bearerTokenUserBuilder('   ')).toThrow(
      /empty A2A bearer token is not a valid authenticator/,
    );
  });

  it('authenticates a request carrying the configured token', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    const user = await userBuilder(
      requestWithHeaders({authorization: `Bearer ${TOKEN}`}),
    );

    expect(user.isAuthenticated).toBe(true);
    expect(user.userName).toBe('a2a-bearer-token');
  });

  it('accepts a case-insensitive bearer scheme', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    const user = await userBuilder(
      requestWithHeaders({authorization: `bearer ${TOKEN}`}),
    );

    expect(user.isAuthenticated).toBe(true);
  });

  it('rejects a request with no Authorization header', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    await expect(userBuilder(requestWithHeaders({}))).rejects.toThrow(
      /missing or invalid/,
    );
  });

  it('rejects a non-bearer scheme', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    await expect(
      userBuilder(requestWithHeaders({authorization: 'Basic czNjcjN0'})),
    ).rejects.toThrow(/missing or invalid/);
  });

  it('rejects a wrong token of the same length', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);
    const wrongToken = 'S3CR3T';
    expect(wrongToken).toHaveLength(TOKEN.length);

    await expect(
      userBuilder(requestWithHeaders({authorization: `Bearer ${wrongToken}`})),
    ).rejects.toThrow(/missing or invalid/);
  });

  it('rejects a wrong token of a different length', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    await expect(
      userBuilder(
        requestWithHeaders({authorization: `Bearer ${TOKEN}-and-more`}),
      ),
    ).rejects.toThrow(/missing or invalid/);
  });

  it('rejects a bearer scheme with an empty credential', async () => {
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    await expect(
      userBuilder(requestWithHeaders({authorization: 'Bearer '})),
    ).rejects.toThrow(/missing or invalid/);
  });

  it('never discloses the configured token', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const userBuilder = bearerTokenUserBuilder(TOKEN);

    const rejection = await userBuilder(
      requestWithHeaders({authorization: 'Bearer wrong'}),
    ).catch((error: unknown) => error);

    if (!(rejection instanceof Error)) {
      expect.fail('expected the authenticator to reject with an Error');
    }
    expect(rejection.message).not.toContain(TOKEN);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
