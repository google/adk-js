/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Loop-self: a node routes back to itself until it guesses the target number.
 * One-to-one port of Python
 * `contributing/samples/workflows/loop_self/agent.py`.
 *
 * TypeScript note: Python's `guess_number(target_number: int)` binds
 * `target_number` from state by parameter name. `FunctionNode` in TypeScript
 * has a fixed `(ctx, input)` signature, so the value is read via `ctx.state`.
 *
 * Run (offline):  npm run sample -- tests/integration/workflows/loop_self/agent.ts
 * Enter a number between 0 and 10.
 */

import {createEvent, node, NodeContext, Workflow} from '@google/adk';

/** Python's `Event(message=...)` content shape (role `user`). */
const message = (text: string) =>
  createEvent({content: {role: 'user', parts: [{text}]}});

/**
 * Python's `int(node_input)`: tolerates surrounding whitespace and a sign, and
 * throws on anything else — `parseInt` would silently accept "3abc".
 */
function parseIntStrict(value: string): number {
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(`invalid literal for int() with base 10: '${value}'`);
  }
  return Number(text);
}

const validateInput = node(
  function* (ctx: NodeContext, nodeInput: string) {
    const parsedNumber = parseIntStrict(nodeInput);
    if (parsedNumber > 10 || parsedNumber < 0) {
      yield message('Please provide a number between 0 and 10.');
      throw new Error('Invalid input.');
    } else {
      ctx.state.set('target_number', parsedNumber);
      yield createEvent({});
    }
  },
  {name: 'validate_input'},
);

const guessNumber = node(
  function* (ctx: NodeContext) {
    const targetNumber = ctx.state.get<number>('target_number');
    const guess = Math.floor(Math.random() * 11);
    yield message(`Guessing ${guess}...`);
    if (guess === targetNumber) {
      yield message('Correct!');
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
