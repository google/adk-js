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

describe('Workflow Samples: Nested Workflow Composition', () => {
  it('should compose a sub-Workflow inside a parent Workflow (nested_workflow sample parity)', async () => {
    const findNameNode = new FunctionNode(
      'find_name',
      (_ctx, input: string) => `Person_${input}`,
    );

    const generateBioNode = new FunctionNode(
      'generate_bio',
      (_ctx, name: string) => `Bio for ${name}: Famous historical author.`,
    );

    // Sub-workflow wraps two sequential steps
    const findFamousPersonWorkflow = new Workflow({
      name: 'find_famous_person_workflow',
      edges: [['START', findNameNode, generateBioNode]],
      outputKey: 'famousPersonResult',
    });

    const findHistoricalEventNode = new FunctionNode(
      'find_historical_event',
      (_ctx, input: string) =>
        `Historical event in year ${input}: First publication of landmark novel.`,
    );

    const joinNode = new JoinNode('join_for_aggregation');

    const formatOutputNode = new FunctionNode(
      'format_output',
      (_ctx, input: Record<string, unknown>) => {
        // When a Workflow node completes inside a parent graph, its final output payload is passed to the join node
        return createEvent({
          message:
            `Person Bio: ${JSON.stringify(input['find_famous_person_workflow'])}\n` +
            `Event: ${input['find_historical_event']}`,
        });
      },
    );

    const rootAgent = new Workflow({
      name: 'nested_root_workflow',
      edges: [
        [
          'START',
          [findFamousPersonWorkflow, findHistoricalEventNode],
          joinNode,
          formatOutputNode,
        ],
      ],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: '1984'}]},
    })) {
      events.push(event);
    }

    const messages = events
      .flatMap((e) => e.content?.parts?.map((p) => p.text) ?? [])
      .join('');
    expect(messages).toContain(
      'Bio for Person_1984: Famous historical author.',
    );
    expect(messages).toContain(
      'Historical event in year 1984: First publication of landmark novel.',
    );
  });
});
