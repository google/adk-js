/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/workflows/loop_self.
 *
 * `guess_number` routes back to itself, which both runtimes express as a
 * routing map whose target is the source node.
 *
 * Python binds `guess_number(target_number: int)` from the workflow state by
 * parameter name; TS handlers are always `(ctx, input)`, so the same value is
 * read explicitly from `ctx.state`.
 */
import {createEvent, Event, node, NodeContext, Workflow} from '@google/adk';

/** Python's `Event(message=...)`: a user-facing message, not node output. */
function message(text: string): Event {
  return createEvent({content: {role: 'model', parts: [{text}]}});
}

const validateInput = node(
  function* (ctx: NodeContext, nodeInput: string) {
    const parsedNumber = Number.parseInt(String(nodeInput), 10);
    if (Number.isNaN(parsedNumber)) {
      // Python's `int(node_input)` raises here; mirror that rather than
      // letting NaN fall through and spin the loop forever.
      throw new Error(`invalid literal for int(): '${String(nodeInput)}'`);
    }
    if (parsedNumber > 10 || parsedNumber < 0) {
      yield message('Please provide a number between 0 and 10.');
      throw new Error('Invalid input.');
    } else {
      ctx.state.set('target_number', parsedNumber);
    }
  },
  {name: 'validate_input'},
);

const guessNumber = node(
  function* (ctx: NodeContext) {
    const targetNumber = ctx.state.get<number>('target_number');
    // Python's `random.randint(0, 10)` is inclusive at both ends.
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
