/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loop: generate → evaluate → route back until the result passes. Mirrors
 * Python `workflows/loop` (generate/evaluate kept function-based to run
 * offline; swap for LlmAgents to use a model).
 *
 * Run:  node dev/dist/esm/cli_entrypoint.js run samples/workflows/loop/agent.ts
 */

import {
  createEvent,
  node,
  NodeContext,
  Workflow,
  WorkflowAgent,
} from '@google/adk';

const processInput = node(
  (ctx: NodeContext, topic: string) => {
    ctx.state.set('topic', topic);
    ctx.state.set('attempt', 0);
    return topic;
  },
  {name: 'process_input'},
);

const generateHeadline = node(
  (ctx: NodeContext) => {
    const attempt = (ctx.state.get<number>('attempt') ?? 0) + 1;
    ctx.state.set('attempt', attempt);
    const topic = ctx.state.get('topic');
    return `Headline draft #${attempt} about "${topic}"`;
  },
  {name: 'generate_headline'},
);

const evaluateHeadline = node(
  (ctx: NodeContext, headline: string) => {
    // Accept on the 3rd attempt (simulates a grader improving over iterations).
    const attempt = ctx.state.get<number>('attempt') ?? 0;
    const grade = attempt >= 3 ? 'tech-related' : 'unrelated';
    return createEvent({route: grade, output: headline});
  },
  {name: 'evaluate_headline'},
);

const finalize = node(
  (_c: NodeContext, headline: string) => `Final headline: ${headline}`,
  {name: 'finalize'},
);

export const rootAgent = new WorkflowAgent(
  new Workflow({
    name: 'loop_sample',
    edges: [
      ['START', processInput, generateHeadline, evaluateHeadline],
      [
        evaluateHeadline,
        {unrelated: generateHeadline, 'tech-related': finalize},
      ],
    ],
  }),
);
