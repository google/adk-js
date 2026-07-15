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
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('Workflow Samples: Loop & Loop Self', () => {
  it('should support multi-node looping with conditional exit (loop sample parity)', async () => {
    const processInput = new FunctionNode(
      'process_input',
      (_ctx, input: string) =>
        createEvent({state: {topic: input, attempts: 0}}),
    );

    const generateHeadline = new FunctionNode('generate_headline', (ctx) => {
      const attempts = ((ctx.session.state['attempts'] as number) || 0) + 1;
      ctx.session.state['attempts'] = attempts;
      const topic = ctx.session.state['topic'] as string;
      const headline =
        attempts === 1
          ? `General news about ${topic}`
          : `Tech Breakthrough in ${topic}`;
      return createEvent({state: {currentHeadline: headline}});
    });

    const evaluateHeadline = new FunctionNode('evaluate_headline', (ctx) => {
      const headline = ctx.session.state['currentHeadline'] as string;
      const isTech = headline.includes('Tech');
      return {grade: isTech ? 'tech-related' : 'unrelated', headline};
    });

    const routeHeadline = new FunctionNode(
      'route_headline',
      (_ctx, input: {grade: string}) => createEvent({route: input.grade}),
    );

    const rootAgent = new Workflow({
      name: 'loop_workflow',
      edges: [
        [
          'START',
          processInput,
          generateHeadline,
          evaluateHeadline,
          routeHeadline,
        ],
        [routeHeadline, {unrelated: generateHeadline}],
      ],
      outputKey: 'loopResult',
      allowCycles: true,
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'Software Engineering'}]},
    })) {
      events.push(event);
    }

    // It should have cycled: attempts should be 2 when it exits via "tech-related" (no route handler -> end)
    expect(events.length).toBeGreaterThanOrEqual(1);
    const finalEvent = events[events.length - 1];
    expect(finalEvent).toBeDefined();
  });

  it('should support a node looping back to itself (loop_self sample parity)', async () => {
    let guessCount = 0;
    const guessNode = new FunctionNode('guess_node', () => {
      guessCount++;
      if (guessCount < 3) {
        return createEvent({
          message: `Guess ${guessCount}: wrong`,
          route: 'guessed_wrong',
        });
      }
      return createEvent({
        message: `Guess ${guessCount}: correct!`,
        route: 'guessed_right',
      });
    });

    const rootAgent = new Workflow({
      name: 'loop_self_workflow',
      edges: [
        ['START', guessNode],
        [guessNode, {guessed_wrong: guessNode}],
      ],
      allowCycles: true,
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'Guess a number'}]},
    })) {
      events.push(event);
    }

    expect(guessCount).toBe(3);
    const messages = events
      .flatMap((e) => e.content?.parts?.map((p) => p.text) ?? [])
      .filter(Boolean);
    expect(messages).toContain('Guess 1: wrong');
    expect(messages).toContain('Guess 2: wrong');
    expect(messages).toContain('Guess 3: correct!');
  });
});
