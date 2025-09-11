/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {Event} from '../events/event.js';

// TODO - b/425992518: replace with lodash deep clone.
export function deepClone<T>(obj: T): T {
  if (obj === undefined) {
    return undefined as T;
  }

  return JSON.parse(JSON.stringify(obj)) as T;
}
