/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiveServerMessage} from '@google/genai';

/**
 * Builds a `LiveServerMessage` for a test.
 *
 * `LiveServerMessage` is a class, not an interface: `text` and `data` are
 * getters over `serverContent`, so a plain object literal is not assignable to
 * it. Those two are excluded from `init` because they have no setter --
 * assigning to one throws at runtime.
 */
export function liveServerMessage(
  init: Partial<Omit<LiveServerMessage, 'text' | 'data'>>,
): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), init);
}
