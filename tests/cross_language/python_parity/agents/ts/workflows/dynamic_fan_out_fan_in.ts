/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/workflows/dynamic_fan_out_fan_in.
 *
 * The orchestrator schedules one dynamic child per topic and gathers them, so
 * the fan-out width is decided at runtime. `asyncio.gather(*tasks)` is
 * `Promise.all(tasks)`; both runtimes assign run ids in CALL order, so the
 * children are started in a synchronous loop before anything is awaited (the
 * same rule adk-js documents in `samples/workflows/dynamic/parallel_route`).
 *
 * Two surface differences:
 *   - `ctx.run_node(...)` resolves to the child's output in Python and to a
 *     node *result* here, so the output is read off `.output`.
 *   - `@node(rerun_on_resume=True)` is `node(fn, {rerunOnResume: true})`; TS
 *     has no decorator form.
 */
import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';

import {PARITY_MODEL} from '../model.ts';

// Worker agent to generate a headline for a single topic
const generator = new LlmAgent({
  name: 'generator',
  model: PARITY_MODEL,
  instruction:
    'Write a catchy one-line headline about the topic provided in the user' +
    ' message.',
});

/** Orchestrator node that performs dynamic fan-out and fan-in. */
const orchestrator = node(
  async function* (ctx: NodeContext, nodeInput: string) {
    // Split input comma-separated string into topics
    const topics = nodeInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: `Processing ${topics.length} topics in parallel.`}],
      },
    });

    // Fan-out: Schedule a dynamic node for each topic
    const tasks = topics.map((topic) =>
      ctx.runNode(generator, topic, {useSubBranch: true}),
    );

    // Wait for all tasks to complete
    const results = await Promise.all(tasks);

    // Fan-in: Aggregate results
    let aggregated = '### Aggregated Headlines\n\n';
    aggregated += '| Topic | Headline |\n';
    aggregated += '| :--- | :--- |\n';
    for (const [i, topic] of topics.entries()) {
      aggregated += `| ${topic} | ${String(results[i]?.output ?? '')} |\n`;
    }

    yield createEvent({content: {role: 'model', parts: [{text: aggregated}]}});
  },
  {name: 'orchestrator', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'dynamic_fan_out_fan_in',
  edges: [['START', orchestrator]],
});
