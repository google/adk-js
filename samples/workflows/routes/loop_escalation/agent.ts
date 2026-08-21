/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loop and escalation exit
 * https://adk.dev/graphs/routes/#loop-and-escalation-exit
 *
 * A loop is a BACK-EDGE in the graph: a downstream node routes back to an
 * earlier node, and the engine re-activates that node with a fresh lifecycle on
 * each iteration. The loop exits when the router picks the terminal branch
 * instead — the graph equivalent of a LoopAgent's escalation exit.
 *
 *   START -> seed_draft -> critic -> router --REVISE--> refine --+
 *                             ^                                  |
 *                             +----------------------------------+
 *                                        router --DONE--> finalize
 *
 * The docs page shows only the generic router for this section; this sample
 * adds the back-edge that actually makes it a loop, and keeps the exit
 * condition deterministic so it terminates.
 *
 * Note: a graph cycle is NOT capped by the framework. Make sure your exit
 * condition always becomes true (here the draft gains a bullet each pass), or
 * bound the loop yourself — see samples/workflows/dynamic/loop_route.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/workflows/routes/loop_escalation/agent.ts
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

interface Draft {
  topic: string;
  bullets: string[];
}

/** The critic is satisfied once the draft has at least this many bullets. */
const REQUIRED_BULLETS = 3;

const seedDraft = node(
  (_ctx: NodeContext, topic: string): Draft => ({
    topic: topic.trim(),
    bullets: [`${topic.trim()} — point 1`],
  }),
  {name: 'seed_draft'},
);

// Runs once per incoming trigger: first from seed_draft, then from every
// refine pass around the back-edge.
const critic = node(
  (_ctx: NodeContext, draft: Draft) =>
    createEvent({
      route: draft.bullets.length >= REQUIRED_BULLETS ? 'DONE' : 'REVISE',
      output: draft,
    }),
  {name: 'critic'},
);

const refine = node(
  (_ctx: NodeContext, draft: Draft): Draft => ({
    ...draft,
    bullets: [
      ...draft.bullets,
      `${draft.topic} — point ${draft.bullets.length + 1}`,
    ],
  }),
  {name: 'refine'},
);

const finalize = node(
  (_ctx: NodeContext, draft: Draft) =>
    `Approved after ${draft.bullets.length} bullets:\n` +
    draft.bullets.map((b) => `  • ${b}`).join('\n'),
  {name: 'finalize'},
);

export const rootAgent = new Workflow({
  name: 'loop_workflow',
  edges: [
    ['START', seedDraft, critic],
    [critic, {REVISE: refine, DONE: finalize}],
    // The back-edge that closes the loop.
    [refine, critic],
  ],
});
