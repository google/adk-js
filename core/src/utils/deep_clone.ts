/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// TODO - b/425992518: replace with lodash deep clone.
export function deepClone<T>(obj: T): T|undefined {
  if (obj === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}