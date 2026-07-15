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
  InvocationContext,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('Workflow Samples: Dynamic Nodes & Dynamic Fan-Out', () => {
  it('should run a dynamic entry workflow scheduling downstream nodes via ctx.runNode (dynamic_nodes sample parity)', async () => {
    const generatorNode = new FunctionNode(
      'generator',
      (_ctx, topic: string) => `Catchy headline about ${topic}`,
    );

    const evaluatorNode = new FunctionNode(
      'evaluator',
      (_ctx, headline: string) => `Evaluated: [${headline}] - Grade A`,
    );

    const dynamicEntryNode = new FunctionNode(
      'orchestrate',
      async (ctx: InvocationContext, topic: string) => {
        // Execute generator using ctx.runNode
        const genOutput = await ctx.runNode(generatorNode, topic);
        // Pass output to evaluator using ctx.runNode
        const evalOutput = await ctx.runNode(evaluatorNode, genOutput);
        return createEvent({message: `Final report: ${evalOutput}`});
      },
    );

    const rootAgent = new Workflow({
      name: 'dynamic_nodes_workflow',
      edges: [['START', dynamicEntryNode]],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'AI Innovations'}]},
    })) {
      events.push(event);
    }

    const messages = events
      .flatMap((e) => e.content?.parts?.map((p) => p.text) ?? [])
      .join('');
    expect(messages).toContain(
      'Final report: Evaluated: [Catchy headline about AI Innovations] - Grade A',
    );
  });

  it('should perform dynamic fan-out and fan-in across items (dynamic_fan_out_fan_in sample parity)', async () => {
    const processTopicNode = new FunctionNode(
      'process_topic',
      (_ctx, topic: string) => `Processed: ${topic.trim().toUpperCase()}`,
    );

    const dynamicOrchestrator = new FunctionNode(
      'orchestrate_fan_out',
      async (ctx: InvocationContext, input: string) => {
        const topics = input.split(',').map((t) => t.trim());
        // Dynamic fan-out executing multiple nodes in parallel via Promise.all with ctx.runNode
        const results = await Promise.all(
          topics.map((topic) => ctx.runNode(processTopicNode, topic)),
        );
        return createEvent({
          message: `Aggregated Topics: ${results.join(' | ')}`,
        });
      },
    );

    const rootAgent = new Workflow({
      name: 'dynamic_fanout_workflow',
      edges: [['START', dynamicOrchestrator]],
    });

    const runner = new InMemoryRunner({agent: rootAgent});
    const events: Event[] = [];

    for await (const event of runner.runEphemeral({
      userId: 'test_user',
      newMessage: {role: 'user', parts: [{text: 'apple, banana, cherry'}]},
    })) {
      events.push(event);
    }

    const messages = events
      .flatMap((e) => e.content?.parts?.map((p) => p.text) ?? [])
      .join('');
    expect(messages).toContain(
      'Aggregated Topics: Processed: APPLE | Processed: BANANA | Processed: CHERRY',
    );
  });
});
