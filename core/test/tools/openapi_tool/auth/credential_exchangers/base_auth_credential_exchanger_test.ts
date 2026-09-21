/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * tests/unittests/tools/openapi_tool/auth/credential_exchangers/test_base_auth_credential_exchanger.py
 * at tag v0.1.0. Test names are kept verbatim so a reviewer can grep the
 * original.
 */

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  AuthScheme,
  BaseAuthCredentialExchanger,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Ported from the reference `MockAuthCredentialExchanger`. The reference
 * returns `AuthCredential(token="some-token")`, which relies on pydantic's
 * permissive extra fields. `AuthCredential` requires `authType` in TypeScript,
 * so the returned credential carries an API key instead.
 */
class MockAuthCredentialExchanger extends BaseAuthCredentialExchanger {
  override exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): AuthCredential {
    return {authType: AuthCredentialTypes.API_KEY, apiKey: 'some-token'};
  }
}

const AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'x-api-key',
  in: 'header',
};

describe('BaseAuthCredentialExchanger', () => {
  it('test_exchange_credential_not_implemented', () => {
    const baseExchanger = new BaseAuthCredentialExchanger();
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'some-token',
    };

    expect(() =>
      baseExchanger.exchangeCredential(AUTH_SCHEME, authCredential),
    ).toThrowError('Subclasses must implement exchangeCredential.');
  });

  it('test_auth_credential_missing_error', () => {
    const errorMessage = 'Test missing credential';

    const error = new AuthCredentialMissingError(errorMessage);

    expect(error.message).toBe(errorMessage);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthCredentialMissingError');
  });
});

describe('BaseAuthCredentialExchanger (adk-js specific)', () => {
  it('returns the subclass credential when the method is overridden', () => {
    const exchanger = new MockAuthCredentialExchanger();

    const credential = exchanger.exchangeCredential(AUTH_SCHEME, {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'incoming-key',
    });

    expect(credential).toEqual({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'some-token',
    });
  });

  it('throws when the optional credential is omitted', () => {
    const baseExchanger = new BaseAuthCredentialExchanger();

    expect(() => baseExchanger.exchangeCredential(AUTH_SCHEME)).toThrowError(
      'Subclasses must implement exchangeCredential.',
    );
  });

  it('carries its message through a catch as an Error', () => {
    let caught: unknown;

    try {
      throw new AuthCredentialMissingError('API key is missing.');
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthCredentialMissingError);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toBe(
      'AuthCredentialMissingError: API key is missing.',
    );
  });
});
