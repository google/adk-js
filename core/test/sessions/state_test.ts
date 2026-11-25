/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isStateSchemaError, State, StateSchemaError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  getDeltaWriteStamp,
  getStateWriteStamp,
} from '../../src/sessions/state_write_order.js';

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

  describe('setDefault', () => {
    it('returns an existing stored value without mutating delta or recording write stamps', () => {
      const value: Record<string, unknown> = {count: 4};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      const result = state.setDefault('count', 99);

      expect(result).toBe(4);
      expect(state.hasDelta()).toBe(false);
      expect(delta).toEqual({});
      expect(getStateWriteStamp(value, 'count')).toBeUndefined();
      expect(getDeltaWriteStamp(delta, 'count')).toBeUndefined();
    });

    it('prefers a pending delta value over the stored value without advancing write stamps', () => {
      const value: Record<string, unknown> = {label: 'stored'};
      const delta: Record<string, unknown> = {label: 'pending'};
      const state = new State(value, delta);

      const result = state.setDefault('label', 'fallback');

      expect(result).toBe('pending');
      expect(value['label']).toBe('stored');
      expect(delta['label']).toBe('pending');
      expect(getStateWriteStamp(value, 'label')).toBeUndefined();
      expect(getDeltaWriteStamp(delta, 'label')).toBeUndefined();
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['zero', 0],
      ['false', false],
      ['empty string', ''],
    ])(
      'preserves an existing own key set to %s without overwriting it',
      (_label, stored) => {
        const value: Record<string, unknown> = {flag: stored};
        const delta: Record<string, unknown> = {};
        const state = new State(value, delta);

        const result = state.setDefault('flag', 'replacement');

        expect(result).toBe(stored);
        expect(value['flag']).toBe(stored);
        expect(state.hasDelta()).toBe(false);
      },
    );

    it('sets a missing key to defaultValue in both value and delta and records write stamps', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      const result = state.setDefault('items', ['a']);

      expect(result).toEqual(['a']);
      expect(value['items']).toEqual(['a']);
      expect(delta['items']).toEqual(['a']);
      expect(state.hasDelta()).toBe(true);
      const stateStamp = getStateWriteStamp(value, 'items');
      const deltaStamp = getDeltaWriteStamp(delta, 'items');
      expect(stateStamp).toBeDefined();
      expect(deltaStamp).toBe(stateStamp);
    });

    it('sets a missing key to undefined when defaultValue is omitted', () => {
      const value: Record<string, unknown> = {};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta);

      const result = state.setDefault('optionalKey');

      expect(result).toBeUndefined();
      expect(Object.hasOwn(value, 'optionalKey')).toBe(true);
      expect(Object.hasOwn(delta, 'optionalKey')).toBe(true);
      expect(state.has('optionalKey')).toBe(true);
      expect(state.hasDelta()).toBe(true);
    });

    it.each(['toString', 'constructor', 'hasOwnProperty'])(
      'treats inherited Object.prototype property %s as missing until set',
      (name) => {
        const state = new State();

        expect(state.setDefault(name, 'initialized')).toBe('initialized');
        expect(state.has(name)).toBe(true);
        expect(state.setDefault(name, 'later')).toBe('initialized');
      },
    );

    it('validates missing keys against schema and throws StateSchemaError without mutating state', () => {
      const schema = z.object({
        counter: z.number().positive(),
        label: z.string(),
      });
      const value: Record<string, unknown> = {counter: 3};
      const delta: Record<string, unknown> = {};
      const state = new State(value, delta, schema);

      expect(() => state.setDefault('undeclared', 'x')).toThrow(
        StateSchemaError,
      );
      try {
        state.setDefault('label', 123);
        expect.fail('Expected setDefault to throw StateSchemaError');
      } catch (err: unknown) {
        expect(isStateSchemaError(err)).toBe(true);
      }
      expect(state.has('undeclared')).toBe(false);
      expect(state.has('label')).toBe(false);
      expect(state.hasDelta()).toBe(false);

      expect(state.setDefault('counter', -10)).toBe(3);
      expect(state.hasDelta()).toBe(false);

      expect(state.setDefault('label', 'ready')).toBe('ready');
      expect(delta).toEqual({label: 'ready'});
    });
  });
});
