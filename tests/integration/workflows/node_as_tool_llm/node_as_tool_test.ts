/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for node/workflow-as-tool: an `LlmAgent` is given a
 * `Workflow` (and a function node) in its `tools`; the framework auto-wraps them
 * as `NodeTool`s so the model can call them, and the node's structured output
 * becomes the tool result. Mirrors the `node_as_tool` sample.
 */

import {
  getFunctionResponses,
  InMemoryRunner,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  functionCallResponse,
  mockLlmAgent,
  textResponse,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — node/workflow as an agent tool', () => {
  it('lets an LlmAgent call a Workflow passed as a tool', async () => {
    const lookup = node(
      (_c: NodeContext, args: {userId: string}) => ({
        userId: args.userId,
        tier: 'Verified VIP Member',
      }),
      {name: 'lookup_customer', inputSchema: z.object({userId: z.string()})},
    );
    const lookupWorkflow = new Workflow({
      name: 'customer_lookup_workflow',
      description: 'Looks up customer status and tier by user_id.',
      inputSchema: z.object({userId: z.string()}),
      edges: [['START', lookup]],
    });

    const agent = mockLlmAgent(
      {
        name: 'customer_service_agent',
        instruction: 'Help the customer.',
        tools: [lookupWorkflow],
      },
      [
        functionCallResponse('customer_lookup_workflow', {userId: 'u123'}),
        textResponse('The customer is a Verified VIP Member.'),
      ],
    );

    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });
    const events = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'look up user u123'}]},
      }),
    );

    // The workflow tool ran and returned the tier as the function response.
    const toolResult = events
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'customer_lookup_workflow');
    expect(toolResult?.response).toMatchObject({
      tier: 'Verified VIP Member',
      userId: 'u123',
    });
  });
});
