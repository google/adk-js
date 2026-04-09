/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {AdkApiServer} from '@google/adk-devtools';

console.log('Importing AdkApiServer works');
if (typeof AdkApiServer !== 'function') {
  throw new Error('AdkApiServer is not a function');
}
console.log('Devtools verification successful');
