/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {redactUriPassword} from '../../src/utils/redact_uri.js';

describe('redactUriPassword', () => {
  it('redacts password from userinfo in URI', () => {
    expect(redactUriPassword('postgres://user:pass@db.host:5432/mydb')).toBe(
      'postgres://user:***@db.host:5432/mydb',
    );
  });

  it('redacts sensitive query parameters', () => {
    expect(
      redactUriPassword('https://example.com/api?access_token=secret_token'),
    ).toBe('https://example.com/api?access_token=***');

    expect(
      redactUriPassword('https://example.com/api?password=my_password'),
    ).toBe('https://example.com/api?password=***');
  });

  it('leaves safe URIs unchanged', () => {
    expect(redactUriPassword('memory://')).toBe('memory://');
    expect(redactUriPassword('rag://my-corpus')).toBe('rag://my-corpus');
    expect(redactUriPassword('agentengine://my-engine')).toBe(
      'agentengine://my-engine',
    );
  });

  it('handles unparseable URIs by preserving scheme prefix', () => {
    expect(redactUriPassword('postgres://user:pass@ db.host/mydb')).toBe(
      'postgres://<unparseable URI, redacted>',
    );
    expect(redactUriPassword('not a uri with secret')).toBe(
      '<unparseable URI, redacted>',
    );
  });
});
