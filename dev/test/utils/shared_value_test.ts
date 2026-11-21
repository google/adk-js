/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isSharedValue,
  SharedValue,
  type SharedValueOptions,
} from '@google/adk-devtools';
import {describe, expect, it} from 'vitest';

describe('SharedValue', () => {
  it('stores initial value and allows mutation from callbacks', () => {
    const options: SharedValueOptions<string> = {value: 'initialApp'};
    const shared = new SharedValue(options);

    expect(shared.value).toBe('initialApp');

    const updateFromCallback = (ref: SharedValue<string>, next: string) => {
      ref.value = next;
    };
    updateFromCallback(shared, 'updatedApp');

    expect(shared.value).toBe('updatedApp');
  });

  it('supports numeric and object values', () => {
    const counter = new SharedValue({value: 0});
    counter.value += 1;
    expect(counter.value).toBe(1);

    const metadata = new SharedValue({value: {appName: 'demoApp', count: 2}});
    metadata.value = {appName: 'nextApp', count: 3};
    expect(metadata.value).toEqual({appName: 'nextApp', count: 3});
  });

  it('identifies SharedValue instances with isSharedValue', () => {
    const shared = new SharedValue({value: 'app'});

    expect(isSharedValue(shared)).toBe(true);
    expect(isSharedValue({value: 'app'})).toBe(false);
    expect(isSharedValue(null)).toBe(false);
    expect(isSharedValue(undefined)).toBe(false);
    expect(isSharedValue('app')).toBe(false);
  });
});
