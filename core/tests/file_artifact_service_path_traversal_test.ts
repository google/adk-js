/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../src/artifacts/file_artifact_service.js';

const ROOT = '/tmp/adk-test-root';

describe('assertSafeSegment - valid inputs', () => {
  it('allows a plain alphanumeric userId', () => {
    expect(() => getUserRoot(ROOT, 'alice')).not.toThrow();
  });
  it('allows a UUID as userId', () => {
    expect(() =>
      getUserRoot(ROOT, '550e8400-e29b-41d4-a716-446655440000'),
    ).not.toThrow();
  });
  it('allows an email-style userId', () => {
    expect(() => getUserRoot(ROOT, 'user.name@org')).not.toThrow();
  });
  it('allows a plain alphanumeric sessionId', () => {
    expect(() =>
      getSessionArtifactsDir(`${ROOT}/users/alice`, 'session-abc123'),
    ).not.toThrow();
  });
});

describe('assertSafeSegment - userId attacks', () => {
  it('blocks dot-dot-slash traversal in userId', () => {
    expect(() => getUserRoot(ROOT, '../../etc')).toThrow('Invalid userId');
  });
  it('blocks forward slash in userId', () => {
    expect(() => getUserRoot(ROOT, 'a/b')).toThrow('Invalid userId');
  });
  it('blocks percent-encoded slash in userId', () => {
    expect(() => getUserRoot(ROOT, '..%2F..%2Fetc')).toThrow('Invalid userId');
  });
  it('blocks null byte in userId', () => {
    expect(() => getUserRoot(ROOT, 'alice\x00')).toThrow('Invalid userId');
  });
  it('blocks empty string as userId', () => {
    expect(() => getUserRoot(ROOT, '')).toThrow('Invalid userId');
  });
});

describe('assertSafeSegment - sessionId attacks', () => {
  const base = `${ROOT}/users/alice`;
  it('blocks dot-dot-slash traversal in sessionId', () => {
    expect(() => getSessionArtifactsDir(base, '../../../secret')).toThrow(
      'Invalid sessionId',
    );
  });
  it('blocks forward slash in sessionId', () => {
    expect(() => getSessionArtifactsDir(base, 'sess/../../etc')).toThrow(
      'Invalid sessionId',
    );
  });
  it('blocks percent-encoded slash in sessionId', () => {
    expect(() => getSessionArtifactsDir(base, '..%2F..%2F..%2Fsecret')).toThrow(
      'Invalid sessionId',
    );
  });
  it('blocks empty string as sessionId', () => {
    expect(() => getSessionArtifactsDir(base, '')).toThrow('Invalid sessionId');
  });
});

describe('assertInsideRoot - defence-in-depth', () => {
  it('throws when resolved path escapes root', () => {
    expect(() =>
      assertInsideRoot('/tmp/root/../outside', '/tmp/root', 'test'),
    ).toThrow('escapes storage root');
  });
  it('allows a path equal to root', () => {
    expect(() =>
      assertInsideRoot('/tmp/root', '/tmp/root', 'test'),
    ).not.toThrow();
  });
  it('allows a path nested inside root', () => {
    expect(() =>
      assertInsideRoot('/tmp/root/users/alice', '/tmp/root', 'test'),
    ).not.toThrow();
  });
});
