/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loop-self: a node routes back to ITSELF until a condition is met (a routed,
 * i.e. conditional, cycle). Mirrors Python `workflows/loop_self` — guesses a
 * random number until it matches the target.
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/loop_self/agent.ts
 * Then type a number between 0 and 10.
 */

import {
  createEvent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const validateInput = node(
  (ctx: NodeContext, input: string) => {
    const n = parseInt(String(input).trim(), 10);
    if (Number.isNaN(n) || n < 0 || n > 10) {
      throw new Error('Please provide a number between 0 and 10.');
    }
    ctx.state.set('target_number', n);
    return n;
  },
  {name: 'validate_input'},
);

const guessNumber = node(
  (ctx: NodeContext) => {
    const target = ctx.state.get<number>('target_number')!;
    const guess = Math.floor(Math.random() * 11);
    if (guess === target) {
      return createEvent({route: 'correct', output: target});
    }
    return createEvent({
      route: 'guessed_wrong',
      content: {
        role: 'model',
        parts: [{text: `Guessed ${guess}, trying again...`}],
      },
    });
  },
  {name: 'guess_number'},
);

const report = node(
  (_c: NodeContext, target: number) => `Correct! The number was ${target}.`,
  {name: 'report'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'loop_self',
    edges: [
      ['START', validateInput, guessNumber],
      [guessNumber, {guessed_wrong: guessNumber, correct: report}],
    ],
  }),
);
