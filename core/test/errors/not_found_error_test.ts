/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError, SessionNotFoundError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('NotFoundError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new NotFoundError().message).toBe(
      'The requested item was not found.',
    );
    expect(new NotFoundError(undefined).message).toBe(
      'The requested item was not found.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(new NotFoundError('No eval set foo.').message).toBe(
      'No eval set foo.',
    );
    // An empty string is a supplied argument, so it must not fall back to the
    // default: only `undefined` triggers a default parameter.
    expect(new NotFoundError('').message).toBe('');
    // No sanitisation: `$` replacement patterns are stored as written.
    expect(new NotFoundError("a $& b $' c").message).toBe("a $& b $' c");
  });

  it('sets name', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new NotFoundError();
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    expect(new NotFoundError()).not.toBeInstanceOf(SessionNotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new NotFoundError('boom');
    }).toThrow(NotFoundError);
  });
});
