/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Constructs the docs sample `samples/workflows/data_handling/schemas` — https://adk.dev/graphs/data-handling/
 *
 * `inputSchema` / `outputSchema` on an agent node, plus a tool. It calls a
 * live model, so it is built but not driven: a `WorkflowAgent` validates its
 * edges in its constructor, which is where a rename or a semantics change in
 * the workflow API turns a sample into a load-time error that still type-
 * checks. The behaviour it adds beyond that is covered by the sibling
 * `tests/integration/workflows/` set.
 */

import {describe, expect, it} from 'vitest';
import {rootAgent} from './agent.js';

describe('docs sample: data_handling/schemas', () => {
  it('builds a valid graph', () => {
    // Importing the module already ran the constructor that validates it.
    expect(rootAgent.name).toBe('flight_workflow');
  });
});
