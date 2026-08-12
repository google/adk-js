/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Constructs the docs sample `samples/workflows/routes/branches` — https://adk.dev/graphs/routes/
 *
 * A router node plus a route-to-node dispatch map. It calls a live model, so
 * it is built but not driven: a `WorkflowAgent` validates its edges in its
 * constructor, which is where a rename or a semantics change in the workflow
 * API turns a sample into a load-time error that still type-checks. The
 * behaviour it adds beyond that is covered by the sibling
 * `tests/integration/workflows/` set.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from './agent.js';

describe('docs sample: routes/branches', () => {
  it('builds a valid graph', () => {
    expect(rootAgent.name).toBe('routing_workflow');
  });
});
