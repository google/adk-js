/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolConfirmation} from '@google/adk';
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
