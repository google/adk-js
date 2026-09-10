/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AlreadyExistsError, NotFoundError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('AlreadyExistsError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new AlreadyExistsError().message).toBe(
      'The resource already exists.',
    );
    expect(new AlreadyExistsError(undefined).message).toBe(
      'The resource already exists.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(new AlreadyExistsError('Session 42 already exists.').message).toBe(
      'Session 42 already exists.',
    );
    expect(new AlreadyExistsError('').message).toBe('');
  });

  it('sets name', () => {
    expect(new AlreadyExistsError().name).toBe('AlreadyExistsError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new AlreadyExistsError();
    expect(error).toBeInstanceOf(AlreadyExistsError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    expect(new AlreadyExistsError()).not.toBeInstanceOf(NotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new AlreadyExistsError('boom');
    }).toThrow(AlreadyExistsError);
  });
});
