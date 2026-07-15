/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  FunctionNode,
  InMemoryRunner,
  JoinNode,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('Workflow Samples: Fan Out Fan In with JoinNode', () => {
  it('should run parallel nodes and aggregate outputs at JoinNode (fan_out_fan_in sample parity)', async () => {
    const makeUppercase = new FunctionNode(
      'make_uppercase',
      (_ctx, input: string) => input.toUpperCase(),
    );

    const countCharacters = new FunctionNode(
      'count_characters',
      (_ctx, input: string) => input.length,
    );

    const reverseString = new FunctionNode(
      'reverse_string',
      (_ctx, input: string) => input.split('').reverse().join(''),
    );

    const joinNode = new JoinNode('join_for_results');

    const aggregateNode = new FunctionNode(
      'aggregate',
      (_ctx, input: Record<string, unknown>) => {
        return createEvent({
          message:
            `Uppercase: ${input['make_uppercase']}\n\n` +
            `Character Count: ${input['count_characters']}\n\n` +
            `Reversed: ${input['reverse_string']}\n\n`,
        });
      },
    );

    const rootAgent = new Workflow({
      name: 'fan_out_fan_in_workflow',
      edges: [
        [
          'START',
          [makeUppercase, countCharacters, reverseString],
          joinNode,
          aggregateNode,
        ],
      ],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'adk workflow'}]},
    })) {
      events.push(event);
    }

    const messages = events
      .flatMap((e) => e.content?.parts?.map((p) => p.text) ?? [])
      .join('');
    expect(messages).toContain('Uppercase: ADK WORKFLOW');
    expect(messages).toContain('Character Count: 12');
    expect(messages).toContain('Reversed: wolfkrow kda');
  });
});
