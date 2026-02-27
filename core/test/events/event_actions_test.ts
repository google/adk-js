/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {mergeEventActions} from '../../src/events/event_actions.js';

describe('mergeEventActions', () => {
  it('overwrites existing nested value with undefined', () => {
    const merged = mergeEventActions([
      {stateDelta: {user: {name: 'Alice', age: 30}}},
      {stateDelta: {user: {name: undefined}}},
    ]);

    expect(merged.stateDelta['user']).toEqual({name: undefined, age: 30});
    expect(
      Object.prototype.hasOwnProperty.call(
        merged.stateDelta['user'] as Record<string, unknown>,
        'name',
      ),
    ).toBe(true);
  });
});
