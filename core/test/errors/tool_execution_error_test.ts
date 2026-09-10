/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError, ToolErrorType, ToolExecutionError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ToolErrorType', () => {
  it('matches the adk-python members, in declaration order', () => {
    expect(Object.values(ToolErrorType)).toEqual([
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'REQUEST_TIMEOUT',
      'INTERNAL_SERVER_ERROR',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
    ]);
    // Pins the count independently, so an added member fails even if the
    // expected list above is ever loosened.
    expect(Object.values(ToolErrorType)).toHaveLength(9);
  });

  it('gives every member a value identical to its name', () => {
    for (const [name, value] of Object.entries(ToolErrorType)) {
      expect(value).toBe(name);
    }
  });
});

describe('ToolExecutionError', () => {
  it('stores the message and leaves errorType undefined when not supplied', () => {
    const error = new ToolExecutionError('Tool blew up.');
    expect(error.message).toBe('Tool blew up.');
    expect(error.errorType).toBeUndefined();
  });

  it('stores a ToolErrorType member', () => {
    expect(
      new ToolExecutionError('boom', ToolErrorType.BAD_REQUEST).errorType,
    ).toBe(ToolErrorType.BAD_REQUEST);
  });

  it('stores a member as its own string value, needing no normalisation', () => {
    // adk-python unwraps `error_type.value`; a TypeScript string-enum member
    // already *is* that string, so direct assignment is equivalent.
    expect(
      new ToolExecutionError('boom', ToolErrorType.NOT_FOUND).errorType,
    ).toBe('NOT_FOUND');
  });

  it('stores a raw string errorType verbatim', () => {
    expect(new ToolExecutionError('boom', '500').errorType).toBe('500');
  });

  it('sets name', () => {
    expect(new ToolExecutionError('boom').name).toBe('ToolExecutionError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new ToolExecutionError('boom');
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    expect(new ToolExecutionError('boom')).not.toBeInstanceOf(NotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new ToolExecutionError('boom', ToolErrorType.GATEWAY_TIMEOUT);
    }).toThrow(ToolExecutionError);
  });
});
