/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Vendored copy of samples/workflows/dynamic_fan_out_fan_in/agent.ts so this integration test
// is self-contained; keep it in sync with the sample.

/**
 * Dynamic fan-out / fan-in: an orchestrator node splits a comma-separated input
 * into topics, fans out a worker LlmAgent per topic via `ctx.runNode()`, waits
 * for all of them, and aggregates the results into a table. Faithful port of
 * Python `contributing/samples/workflows/dynamic_fan_out_fan_in`.
 *
 * Requires an API key (calls a live model). Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/workflows/dynamic_fan_out_fan_in/agent.ts
 * Enter a comma-separated list of topics, e.g. "space, oceans, volcanoes".
 */

import {createEvent, LlmAgent, node, NodeContext, Workflow} from '@google/adk';

// Worker agent to generate a headline for a single topic.
const generator = new LlmAgent({
  name: 'generator',
  model: 'gemini-2.5-flash',
  instruction:
    'Write a catchy one-line headline about the topic provided in the user message.',
});
const generatorNode = node(generator);

const orchestrator = node(
  async function* (ctx: NodeContext, nodeInput: string) {
    // Split input comma-separated string into topics.
    const topics = String(nodeInput)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    yield createEvent({
      content: {
        role: 'model',
        parts: [{text: `Processing ${topics.length} topics in parallel.`}],
      },
    });

    // Fan-out: schedule a dynamic node for each topic.
    const tasks = topics.map((topic, i) =>
      ctx.runNode(generatorNode, topic, {
        useSubBranch: true,
        runId: `gen-${i}`,
      }),
    );

    // Wait for all tasks to complete.
    const results = await Promise.all(tasks);

    // Fan-in: aggregate results.
    let aggregated = '### Aggregated Headlines\n\n';
    aggregated += '| Topic | Headline |\n';
    aggregated += '| :--- | :--- |\n';
    topics.forEach((topic, i) => {
      aggregated += `| ${topic} | ${results[i].output} |\n`;
    });

    yield createEvent({
      content: {role: 'model', parts: [{text: aggregated}]},
    });
  },
  {name: 'orchestrator', rerunOnResume: true},
);

export const rootAgent = new Workflow({
  name: 'dynamic_fan_out_fan_in',
  edges: [['START', orchestrator]],
});
