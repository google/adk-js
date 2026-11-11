/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IntentMismatchError,
  ToolConfirmation,
  isIntentMismatchError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ToolConfirmation', () => {
  it('stores all provided fields', () => {
    const confirmation = new ToolConfirmation({
      hint: 'Please confirm.',
      confirmed: true,
      payload: {key: 'value'},
    });

    expect(confirmation.hint).toBe('Please confirm.');
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.payload).toEqual({key: 'value'});
  });

  it('defaults hint to empty string when omitted', () => {
    const confirmation = new ToolConfirmation({confirmed: false});

    expect(confirmation.hint).toBe('');
  });

  it('stores confirmed as false', () => {
    const confirmation = new ToolConfirmation({confirmed: false});

    expect(confirmation.confirmed).toBe(false);
  });

  it('stores confirmed as true', () => {
    const confirmation = new ToolConfirmation({confirmed: true});

    expect(confirmation.confirmed).toBe(true);
  });

  it('leaves payload as undefined when not provided', () => {
    const confirmation = new ToolConfirmation({confirmed: true});

    expect(confirmation.payload).toBeUndefined();
  });

  it('accepts a JSON-serializable payload object', () => {
    const payload = {userId: 123, action: 'delete', tags: ['a', 'b']};
    const confirmation = new ToolConfirmation({
      confirmed: true,
      payload,
    });

    expect(() => JSON.stringify(confirmation.payload)).not.toThrow();
    expect(JSON.parse(JSON.stringify(confirmation.payload))).toEqual(payload);
  });
});

describe('IntentMismatchError', () => {
  it('names the call and the failed check, without any argument values', () => {
    const error = new IntentMismatchError({
      reason: 'arguments_mismatch',
      functionCallId: 'orig-1',
    });

    expect(error.message).toBe(
      "Tool confirmation rejected for function call 'orig-1': arguments_mismatch.",
    );
    expect(error.reason).toBe('arguments_mismatch');
    expect(error.functionCallId).toBe('orig-1');
    expect(error.name).toBe('IntentMismatchError');
  });

  it('omits the call when the request never named one', () => {
    const error = new IntentMismatchError({reason: 'malformed_request'});

    expect(error.message).toBe(
      'Tool confirmation rejected: malformed_request.',
    );
    expect(error.functionCallId).toBeUndefined();
  });

  it('survives instanceof and the name-based guard', () => {
    const error = new IntentMismatchError({reason: 'unregistered_tool'});

    expect(error).toBeInstanceOf(IntentMismatchError);
    expect(error).toBeInstanceOf(Error);
    expect(isIntentMismatchError(error)).toBe(true);
  });

  it('does not match an unrelated error or a non-error', () => {
    expect(isIntentMismatchError(new Error('nope'))).toBe(false);
    expect(isIntentMismatchError('IntentMismatchError')).toBe(false);
  });
});
