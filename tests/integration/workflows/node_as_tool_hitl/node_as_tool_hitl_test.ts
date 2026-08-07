/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for HITL through a node-tool: an `LlmAgent` calls a node
 * (passed as a tool) that raises a `RequestInput` while running. The invocation
 * pauses; on the next turn the user answers the interrupt, the node-tool is
 * re-run with the answer threaded as `resumeInputs`, and the tool result flows
 * back to the model. Mirrors the `node_as_tool` `calculate_discount` pattern.
 */

import {
  getFunctionCalls,
  getFunctionResponses,
  InMemoryRunner,
  node,
  NodeContext,
  RequestInput,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  functionCallResponse,
  mockLlmAgent,
  textResponse,
} from '../_harness/workflow_test_utils.js';

describe('workflow integration — HITL through a node-tool', () => {
  it('pauses on RequestInput raised inside a node-tool and resumes', async () => {
    const calculateDiscount = node(
      (ctx: NodeContext, args: {tier: string}) => {
        const resume = ctx.resumeInputs['confirm_vip_discount'];
        if (!args.tier.includes('VIP')) {
          return '5% off';
        }
        if (resume === undefined) {
          return new RequestInput({
            interruptId: 'confirm_vip_discount',
            message: `Apply VIP discount for tier '${args.tier}'?`,
          });
        }
        const answer =
          typeof resume === 'object' && resume !== null
            ? (resume as {text?: string}).text
            : resume;
        return String(answer).toLowerCase() === 'yes'
          ? '20% off'
          : '5% off (VIP declined)';
      },
      {
        name: 'calculate_discount',
        inputSchema: z.object({tier: z.string()}),
        rerunOnResume: true,
      },
    );

    const agent = mockLlmAgent(
      {
        name: 'discount_agent',
        instruction: 'Compute the discount.',
        tools: [calculateDiscount],
      },
      [
        functionCallResponse('calculate_discount', {
          tier: 'Verified VIP Member',
        }),
        textResponse('You get 20% off.'),
      ],
    );

    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });

    // Turn 1: the model calls the node-tool; the node interrupts for input.
    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'What discount do I get?'}]},
      }),
    );
    const raisedInterrupt = turn1
      .flatMap((e) => getFunctionCalls(e))
      .some((fc) => fc.name === 'adk_request_input');
    expect(raisedInterrupt).toBe(true);

    // Turn 2: the user answers the interrupt; the node-tool re-runs and resolves.
    const resume: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'confirm_vip_discount',
            name: 'adk_request_input',
            response: {result: 'yes'},
          },
        },
      ],
    };
    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: resume,
      }),
    );

    const discountResult = turn2
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'calculate_discount');
    expect(discountResult?.response).toMatchObject({result: '20% off'});
  });
});
