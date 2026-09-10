/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError, SessionNotFoundError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('SessionNotFoundError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new SessionNotFoundError().message).toBe('Session not found.');
    expect(new SessionNotFoundError(undefined).message).toBe(
      'Session not found.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(new SessionNotFoundError('No session 42.').message).toBe(
      'No session 42.',
    );
    expect(new SessionNotFoundError('').message).toBe('');
  });

  it('sets name', () => {
    expect(new SessionNotFoundError().name).toBe('SessionNotFoundError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new SessionNotFoundError();
    expect(error).toBeInstanceOf(SessionNotFoundError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    // The hierarchy is flat: SessionNotFoundError must not extend
    // NotFoundError, or `catch (e) { if (e instanceof NotFoundError) }` would
    // start swallowing session lookups it does not swallow in adk-python.
    expect(new SessionNotFoundError()).not.toBeInstanceOf(NotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new SessionNotFoundError('boom');
    }).toThrow(SessionNotFoundError);
  });
});
