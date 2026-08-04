/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getArtifactServiceFromUri} from '../../src/artifacts/registry.js';
import {getConnectionOptionsFromUri} from '../../src/sessions/db/operations.js';
import {getSessionServiceFromUri} from '../../src/sessions/registry.js';
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

  it('does not leak anything after the scheme for unparseable input', () => {
    const out = redactUriPassword('not a url with :hunter2@ inside it');
    expect(out).not.toContain('hunter2');
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
});
