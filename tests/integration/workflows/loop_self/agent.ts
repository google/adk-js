/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/loop_self/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Loop-self: a node routes back to itself until it guesses the target number.
 * Faithful port of Python `contributing/samples/workflows/loop_self`.
 *
 * Run (offline):  npm run sample -- samples/workflows/loop_self/agent.ts
 * Enter a number between 0 and 10.
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

const validateInput = node(
  function* (ctx: NodeContext, nodeInput: string) {
    const parsed = parseInt(String(nodeInput).trim(), 10);
    if (Number.isNaN(parsed) || parsed > 10 || parsed < 0) {
      yield createEvent({
        content: {
          role: 'model',
          parts: [{text: 'Please provide a number between 0 and 10.'}],
        },
      });
      throw new Error('Invalid input.');
    }
    ctx.state.set('target_number', parsed);
  },
  {name: 'validate_input'},
);

const guessNumber = node(
  function* (ctx: NodeContext) {
    const target = ctx.state.get<number>('target_number');
    const guess = Math.floor(Math.random() * 11);
    yield createEvent({
      content: {role: 'model', parts: [{text: `Guessing ${guess}...`}]},
    });
    if (guess === target) {
      yield createEvent({
        content: {role: 'model', parts: [{text: 'Correct!'}]},
      });
    } else {
      yield createEvent({route: 'guessed_wrong'});
    }
  },
  {name: 'guess_number'},
);

export const rootAgent = new Workflow({
  name: 'root_agent',
  edges: [
    ['START', validateInput, guessNumber],
    [guessNumber, {guessed_wrong: guessNumber}],
  ],
});
