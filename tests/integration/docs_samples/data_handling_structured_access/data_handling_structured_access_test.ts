/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `data_handling/structured_access` — https://adk.dev/graphs/
 *
 * Calls a live model, so it is constructed but not driven: a `WorkflowAgent`
 * validates its edges in its constructor, which is where a rename or a
 * semantics change in the workflow API turns a sample into a load-time error
 * that still type-checks. Behaviour beyond that is covered by the sibling
 * `tests/integration/workflows/` set.
 */

import {describe, it} from 'vitest';
import {loadRootAgent} from '../_shared.js';

describe('docs sample: data_handling/structured_access', () => {
  it('builds a valid graph', async () => {
    await loadRootAgent('data_handling/structured_access');
  });
});
