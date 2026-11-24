/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const SHARED_VALUE_SIGNATURE_SYMBOL = Symbol.for('google.adk.sharedValue');

/**
 * Options for constructing a {@link SharedValue}.
 */
export interface SharedValueOptions<T> {
  value: T;
}

/**
 * Mutable value wrapper that lets callbacks and event handlers read and update
 * a shared reference.
 */
export class SharedValue<T> {
  readonly [SHARED_VALUE_SIGNATURE_SYMBOL] = true;
  value: T;

  constructor(options: SharedValueOptions<T>) {
    this.value = options.value;
  }
}

/**
 * Type guard that checks whether `value` is a {@link SharedValue}.
 */
export function isSharedValue<T = unknown>(
  value: unknown,
): value is SharedValue<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    SHARED_VALUE_SIGNATURE_SYMBOL in value &&
    value[SHARED_VALUE_SIGNATURE_SYMBOL] === true
  );
}
