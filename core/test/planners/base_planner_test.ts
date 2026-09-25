/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BuiltInPlanner,
  isBasePlanner,
  isBuiltInPlanner,
  PlanReActPlanner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('isBasePlanner', () => {
  it('is true for the planner classes', () => {
    expect(isBasePlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(true);
    expect(isBasePlanner(new PlanReActPlanner())).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a string', 'planner'],
    [
      'an object with the symbol set to false',
      {[Symbol.for('google.adk.basePlanner')]: false},
    ],
  ])('is false for %s', (_name, value) => {
    expect(isBasePlanner(value)).toBe(false);
  });

  it('is true for an object from another copy of the package', () => {
    expect(isBasePlanner({[Symbol.for('google.adk.basePlanner')]: true})).toBe(
      true,
    );
  });
});

describe('isBuiltInPlanner', () => {
  it('is true for BuiltInPlanner', () => {
    expect(isBuiltInPlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(
      true,
    );
  });

  it.each([
    ['PlanReActPlanner', new PlanReActPlanner()],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a string', 'planner'],
    [
      'an object with the symbol set to false',
      {[Symbol.for('google.adk.builtInPlanner')]: false},
    ],
  ])('is false for %s', (_name, value) => {
    expect(isBuiltInPlanner(value)).toBe(false);
  });

  it('is true for an object from another copy of the package', () => {
    expect(
      isBuiltInPlanner({[Symbol.for('google.adk.builtInPlanner')]: true}),
    ).toBe(true);
  });
});
