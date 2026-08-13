/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {node, NodeContext} from '@google/adk';

/**
 * A node that is not a `Workflow`. It has no conversational entry point, so it
 * is not a root — discovery must keep skipping it even now that a `Workflow` is
 * accepted.
 */
export const rootAgent = node(
  (_ctx: NodeContext, question: string) => question,
  {name: 'lonely'},
);
