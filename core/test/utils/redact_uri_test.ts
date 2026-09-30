/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {getArtifactServiceFromUri} from '../../src/artifacts/registry.js';
import {parseAuthorizationCode} from '../../src/auth/oauth2/oauth2_utils.js';
import {getConnectionOptionsFromUri} from '../../src/sessions/db/operations.js';
import {getSessionServiceFromUri} from '../../src/sessions/registry.js';
import {logger} from '../../src/utils/logger.js';
import {redactUriPassword} from '../../src/utils/redact_uri.js';

describe('redactUriPassword', () => {
  it('masks the password while keeping the rest of the URI', () => {
    expect(redactUriPassword('postgres://user:pass@db.host:5432/mydb')).toBe(
      'postgres://user:***@db.host:5432/mydb',
    );
  });

  it('masks the password for unsupported schemes too', () => {
    expect(redactUriPassword('oracle://admin:hunter2@ora.host/xe')).toBe(
      'oracle://admin:***@ora.host/xe',
    );
  });

  it('leaves a URI without a password unchanged', () => {
    expect(redactUriPassword('postgres://user@db.host/mydb')).toBe(
      'postgres://user@db.host/mydb',
    );
  });

  it('masks a password passed as a query parameter', () => {
    expect(
      redactUriPassword('postgres://user@db.host/mydb?password=hunter2'),
    ).toBe('postgres://user@db.host/mydb?password=***');
  });

  it('masks a query-parameter password with no userinfo at all', () => {
    expect(redactUriPassword('postgres://db.host/mydb?password=hunter2')).toBe(
      'postgres://db.host/mydb?password=***',
    );
  });

  it('matches secret query parameters case-insensitively', () => {
    const out = redactUriPassword('mysql://db.host/mydb?PWD=hunter2');
    expect(out).not.toContain('hunter2');
    expect(out).toBe('mysql://db.host/mydb?PWD=***');
  });

  it('masks the userinfo and query passwords together', () => {
    expect(
      redactUriPassword('postgres://user:pass@db.host/mydb?password=hunter2'),
    ).toBe('postgres://user:***@db.host/mydb?password=***');
  });

  it('keeps non-secret query parameters intact', () => {
    expect(
      redactUriPassword(
        'postgres://db.host/mydb?sslmode=require&password=hunter2&application_name=adk',
      ),
    ).toBe(
      'postgres://db.host/mydb?sslmode=require&password=***&application_name=adk',
    );
  });

  it('leaves a URI with no credential anywhere unchanged', () => {
    expect(redactUriPassword('postgres://db.host/mydb?sslmode=require')).toBe(
      'postgres://db.host/mydb?sslmode=require',
    );
  });

  it('does not leak anything after the scheme for unparseable input', () => {
    const out = redactUriPassword('not a url with :hunter2@ inside it');
    expect(out).not.toContain('hunter2');
  });

  it('says the value was redacted rather than looking empty', () => {
    expect(redactUriPassword('postgres//db.host/mydb')).toBe(
      '<unparseable URI, redacted>',
    );
    expect(redactUriPassword('postgres://user:pass@ db.host/mydb')).toBe(
      'postgres://<unparseable URI, redacted>',
    );
  });
});

describe('connection-URI errors do not leak the password', () => {
  it('getConnectionOptionsFromUri redacts the password in its error', async () => {
    await expect(
      getConnectionOptionsFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).rejects.toThrow(/oracle:\/\/admin:\*\*\*@ora\.host\/xe/);
    await expect(
      getConnectionOptionsFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).rejects.not.toThrow(/hunter2/);
  });

  it('getSessionServiceFromUri redacts the password in its error', () => {
    expect(() =>
      getSessionServiceFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).toThrow(/oracle:\/\/admin:\*\*\*@ora\.host\/xe/);
    expect(() =>
      getSessionServiceFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).not.toThrow(/hunter2/);
  });

  it('getArtifactServiceFromUri redacts the password in its error', () => {
    expect(() =>
      getArtifactServiceFromUri('s3://admin:hunter2@bucket/prefix'),
    ).toThrow(/s3:\/\/admin:\*\*\*@bucket\/prefix/);
    expect(() =>
      getArtifactServiceFromUri('s3://admin:hunter2@bucket/prefix'),
    ).not.toThrow(/hunter2/);
  });

  it('parseAuthorizationCode does not leak the code on a malformed callback URI', () => {
    // A malformed authorization-response URI (missing scheme) still carries
    // a recognizable authorization code in its query string, and previously
    // this fell through to a log statement that included the raw URI.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = parseAuthorizationCode(
        'not-a-valid-scheme?code=SECRET_AUTH_CODE&state=xyz',
      );
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      const loggedText = warnSpy.mock.calls
        .map((call) => call.join(' '))
        .join(' ');
      expect(loggedText).not.toContain('SECRET_AUTH_CODE');
      expect(loggedText).toContain('<unparseable URI, redacted>');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    'code',
    'access_token',
    'id_token',
    'refresh_token',
    'client_secret',
  ])('redacts the %s query parameter', (param) => {
    expect(
      redactUriPassword(`https://app/callback?${param}=SECRET&state=xyz`),
    ).toBe(`https://app/callback?${param}=***&state=xyz`);
  });
});
