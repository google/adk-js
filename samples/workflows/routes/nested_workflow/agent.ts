/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nested workflows
 * https://adk.dev/graphs/routes/#nested-workflows
 *
 * A `Workflow` is itself a node, so it can be dropped straight into another
 * workflow's edges to encapsulate a reusable sub-process.
 *
 * Nested workflow data output: while the inner workflow runs, each of its node
 * events bubbles up to the parent for traceability. When it finishes, the output
 * of its terminal node becomes the output of the nested-workflow node.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/nested_workflow/agent.ts
 * Try "hello there" (workflow B) or "HELLO THERE" (workflow C).
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

const taskA1 = node(
  (_ctx: NodeContext, nodeInput: string) => nodeInput.trim(),
  {name: 'task_A1'},
);

const router = node(
  (_ctx: NodeContext, text: string) =>
    createEvent({
      route: text === text.toUpperCase() ? 'RUN_WORKFLOW_C' : 'RUN_WORKFLOW_B',
      output: text,
    }),
  {name: 'router'},
);

/**
 * Upper-cases the first letter of each word.
 *
 * Unicode-aware on purpose: `\b\w` is ASCII-only, so `ü` never matches — and
 * the word boundary it creates before the *next* ASCII letter upper-cases that
 * one instead ("strässe" -> "SträSse"). A letter whose uppercase form is more
 * than one code point (German `ß` -> "SS") is left alone rather than mangled.
 */
const titleCase = (text: string) =>
  text.replace(/(^|\P{L})(\p{L})/gu, (_match, sep: string, ch: string) => {
    const upper = ch.toUpperCase();
    return sep + ([...upper].length === 1 ? upper : ch);
  });

// --- Sub-workflow B: title-case each word, then frame it. ---
const workflowB = new Workflow({
  name: 'workflow_B',
  edges: [
    [
      'START',
      node((_ctx: NodeContext, text: string) => titleCase(text), {
        name: 'b_title_case',
      }),
      node((_ctx: NodeContext, text: string) => `[B] ${text}`, {
        name: 'b_frame',
      }),
    ],
  ],
});

// --- Sub-workflow C: lower-case, then frame it. ---
const workflowC = new Workflow({
  name: 'workflow_C',
  edges: [
    [
      'START',
      node((_ctx: NodeContext, text: string) => text.toLowerCase(), {
        name: 'c_lower_case',
      }),
      node((_ctx: NodeContext, text: string) => `[C] ${text}`, {
        name: 'c_frame',
      }),
    ],
  ],
});

export const rootAgent = new Workflow({
  name: 'parent_workflow',
  edges: [
    ['START', taskA1, router],
    [
      router,
      {
        RUN_WORKFLOW_B: workflowB,
        RUN_WORKFLOW_C: workflowC,
      },
    ],
  ],
});
