/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `graphs/get_started` — https://adk.dev/graphs/
 *
 * Calls a live model, so it is constructed but not driven: a `WorkflowAgent`
 * validates its edges in its constructor, which is where a rename or a
 * semantics change in the workflow API turns a sample into a load-time error
 * that still type-checks. Behaviour beyond that is covered by the sibling
 * `tests/integration/workflows/` set.
 */

import {describe, it} from 'vitest';
import {loadRootAgent} from '../_shared.js';

describe('docs sample: graphs/get_started', () => {
  it('builds a valid graph', async () => {
    await loadRootAgent('graphs/get_started');
  });
});
