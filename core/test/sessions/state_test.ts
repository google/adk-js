/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {State} from '../../src/sessions/state.js';

describe('State', () => {
  describe('update', () => {
    it('preserves object references for delta and value', () => {
      const delta: Record<string, unknown> = {};
      const value: Record<string, unknown> = {};
      const state = new State(value, delta);

      const updates = {key: 'newValue'};
      state.update(updates);

      // Verify that the object passed to the constructor is mutated,
      // which confirms the reference was preserved.
      expect(delta['key']).toBe('newValue');
      expect(value['key']).toBe('newValue');

      // Verify state.get returns the updated value
      expect(state.get('key')).toBe('newValue');
    });

    it('handles multiple updates correctly', () => {
      const delta: Record<string, unknown> = {};
      const value: Record<string, unknown> = {};
      const state = new State(value, delta);

      state.update({key1: 'value1'});
      state.update({key2: 'value2', key1: 'value1_updated'});

      expect(delta['key1']).toBe('value1_updated');
      expect(delta['key2']).toBe('value2');
      expect(value['key1']).toBe('value1_updated');
      expect(value['key2']).toBe('value2');
    });
  });

  describe('own-key lookup', () => {
    const inheritedNames = [
      'toString',
      'constructor',
      'hasOwnProperty',
      '__proto__',
    ];

    it.each(inheritedNames)('has() is false for inherited %s', (name) => {
      expect(new State().has(name)).toBe(false);
    });

    it.each(inheritedNames)('get() misses inherited %s', (name) => {
      const state = new State();

      expect(state.get(name)).toBeUndefined();
      expect(state.get(name, 'x')).toBe('x');
    });

    it('finds a toString key that set() wrote', () => {
      const state = new State();

      state.set('toString', 'mine');

      expect(state.has('toString')).toBe(true);
      expect(state.get('toString')).toBe('mine');
    });

    it('finds a key held only in the initial value', () => {
      const state = new State({stored: 1});

      expect(state.has('stored')).toBe(true);
      expect(state.get('stored')).toBe(1);
    });

    it('finds a key held only in the delta', () => {
      const state = new State({}, {pending: 2});

      expect(state.has('pending')).toBe(true);
      expect(state.get('pending')).toBe(2);
    });

    it('prefers the delta over the stored value', () => {
      const state = new State({key: 'stored'}, {key: 'pending'});

      expect(state.get('key')).toBe('pending');
    });

    it('works on null-prototype maps', () => {
      const value: Record<string, unknown> = Object.create(null);
      value['key'] = 'v';
      const state = new State(value, Object.create(null));

      expect(state.has('key')).toBe(true);
      expect(state.get('key')).toBe('v');
      expect(state.has('toString')).toBe(false);
    });
  });
});
