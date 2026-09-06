/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlanner,
  BuiltInPlanner,
  isBasePlanner,
  PlanReActPlanner,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

class CustomPlanner extends BasePlanner {
  override buildPlanningInstruction(): string {
    return 'custom instruction';
  }
  override processPlanningResponse(): Part[] | undefined {
    return undefined;
  }
}

describe('isBasePlanner', () => {
  it('accepts a custom BasePlanner subclass', () => {
    expect(isBasePlanner(new CustomPlanner())).toBe(true);
  });

  it('accepts the built-in planners', () => {
    expect(isBasePlanner(new BuiltInPlanner({thinkingConfig: {}}))).toBe(true);
    expect(isBasePlanner(new PlanReActPlanner())).toBe(true);
  });

  it('rejects undefined, null, and a plain object', () => {
    expect(isBasePlanner(undefined)).toBe(false);
    expect(isBasePlanner(null)).toBe(false);
    expect(isBasePlanner({})).toBe(false);
  });

  it('rejects an object that fakes the brand with a wrong value', () => {
    const impostor = {[Symbol.for('google.adk.basePlanner')]: 'yes'};
    expect(isBasePlanner(impostor)).toBe(false);
  });
});
