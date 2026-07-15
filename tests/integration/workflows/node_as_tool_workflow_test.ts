/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  createEvent,
  FunctionNode,
  LlmAgent,
  Workflow,
} from '@google/adk';
import {describe, it} from 'vitest';
import {runTestCase} from '../test_case_utils.js';

describe('Workflow Samples: Node / Workflow as Tool', () => {
  it('should allow an LlmAgent to call a Workflow wrapped via AgentTool (node_as_tool sample parity)', async () => {
    const lookupDbNode = new FunctionNode(
      'lookup_db',
      (_ctx, customerId: string) => {
        if (customerId === 'C123') {
          return JSON.stringify({name: 'Jane Doe', tier: 'Gold', balance: 450});
        }
        return JSON.stringify({error: 'Customer not found'});
      },
    );

    const customerLookupWorkflow = new Workflow({
      name: 'customer_lookup_workflow',
      edges: [['START', lookupDbNode]],
    });

    const workflowTool = new AgentTool({
      agent: customerLookupWorkflow,
    });

    const rootAgent = new LlmAgent({
      name: 'customer_service_agent',
      instruction:
        'Use the lookup_customer tool when asked for customer details.',
      tools: [workflowTool],
    });

    await runTestCase({
      agent: rootAgent,
      turns: [
        {
          userPrompt: 'Can you check details for customer C123?',
          expectedEvents: [
            createEvent({
              author: 'customer_service_agent',
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call_lookup_1',
                      name: 'lookup_customer',
                      args: {input: 'C123'},
                    },
                  },
                ],
              },
            }),
            createEvent({
              author: 'customer_service_agent',
              content: {
                role: 'model',
                parts: [
                  {
                    text: 'Customer C123 is Jane Doe with Gold tier and a balance of $450.',
                  },
                ],
              },
            }),
          ],
        },
      ],
      modelResponses: [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call_lookup_1',
                      name: 'lookup_customer',
                      args: {input: 'C123'},
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: 'Customer C123 is Jane Doe with Gold tier and a balance of $450.',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });
});
